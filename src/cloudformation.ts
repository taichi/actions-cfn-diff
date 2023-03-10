import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as core from "@actions/core";
import {
  CloudFormationClient,
  DescribeStackDriftDetectionStatusCommand,
  DetectStackDriftCommand,
  GetTemplateCommand,
  ListStackResourcesCommand,
  ListStacksCommand,
  StackDriftDetectionStatus,
  StackDriftStatus,
  StackResourceDriftStatus,
  StackResourceSummary,
  StackStatus,
  StackSummary,
} from "@aws-sdk/client-cloudformation";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { AttemptContext, retry } from "@lifeomic/attempt";
import * as yaml from "js-yaml";

import {
  writeDifferenceSummary,
  writeDifferenceSummaryWithDrift,
  writeSummary,
} from "./summary";

const region = core.getInput("aws-region");

export const processCloudFormation = async () => {
  const targets = await detectTargets();
  core.debug(`targets ${JSON.stringify(Object.keys(targets))}`);

  const client = await createCfnClient();
  const stacks = await listStacks(client, (value) => {
    return !!(value.StackName && targets[value.StackName]);
  });

  const currentStacks = stacks.map((value) => value.StackName || "");

  const autoDrift = core.getBooleanInput("enable-drift-detection");
  const driftStatus = autoDrift
    ? await detectStackDriftStatus(client, currentStacks)
    : {};

  for (const [name, filepath] of Object.entries(targets)) {
    const target = await parseTemplate(filepath);
    if (currentStacks.includes(name)) {
      const current = await getCurrentTemplate(client, name);
      const resources = await listStackResources(client, name);

      const stackId =
        stacks.find((stack) => stack.StackName === name)?.StackId ?? "";

      if (autoDrift) {
        const drift = detectDriftStatus(driftStatus[name], resources);

        await writeDifferenceSummaryWithDrift(
          name,
          stackId,
          current,
          target,
          resources,
          drift
        );
      } else {
        await writeDifferenceSummary(name, stackId, current, target, resources);
      }
    } else {
      await writeSummary(name, target);
    }
  }
};

export const createCfnClient = async () => {
  const role = core.getInput("role-to-assume");
  if (role) {
    const sts = new STSClient({ region });
    const command = new AssumeRoleCommand({
      RoleArn: role,
      RoleSessionName: `actions-cfn-diff-${randomUUID()}`,
    });
    const response = await sts.send(command);
    return new CloudFormationClient({
      region,
      credentials: {
        accessKeyId: response.Credentials?.AccessKeyId || "",
        secretAccessKey: response.Credentials?.SecretAccessKey || "",
        sessionToken: response.Credentials?.SessionToken,
      },
    });
  }

  return new CloudFormationClient({ region });
};

export const listStacks = async (
  client: CloudFormationClient,
  filterFn: (ss: StackSummary) => boolean,
  nextToken?: string
): Promise<StackSummary[]> => {
  const response = await client.send(
    new ListStacksCommand({
      NextToken: nextToken,
      StackStatusFilter: [
        StackStatus.CREATE_COMPLETE,
        StackStatus.ROLLBACK_COMPLETE,
        StackStatus.IMPORT_COMPLETE,
        StackStatus.IMPORT_ROLLBACK_COMPLETE,
        StackStatus.UPDATE_COMPLETE,
        StackStatus.UPDATE_ROLLBACK_COMPLETE,
      ],
    })
  );

  const result = response.StackSummaries?.filter(filterFn) || [];

  if (response.NextToken) {
    const inner = await listStacks(client, filterFn, response.NextToken);
    return result.concat(inner) || inner;
  }

  return result;
};

export const detectTargets = async () => {
  const pairs = core.getInput("stack-with-templates");
  if (pairs) {
    const values = parseStackWithTemplate(pairs);
    if (0 < Object.keys(values).length) {
      core.debug(`loaded targets ${values}`);
      return values;
    }
    core.debug(`there are no stack and templates ${values}`);
  }

  const cdkDir = core.getInput("cdk-outputs-directory");
  const stat = await fs.promises.stat(cdkDir);
  if (stat && stat.isDirectory()) {
    const values = await detectCdkOutputs(cdkDir);
    core.debug(`detected targets ${values}`);
    return values;
  }

  return {};
};

const parseStackWithTemplate = (values: string) => {
  const pairs = values
    .split(/\r?\n/)
    .filter((line) => 0 < line.indexOf("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [
        line.substring(0, index - 1),
        line.substring(index + 1, line.length),
      ];
    });
  return toAccessibleTemplates(pairs);
};

const toAccessibleTemplates = (values: string[][]) => {
  return values
    .filter(([_, value]) => {
      const stat = fs.statSync(value);
      if (stat && stat.isFile()) {
        return true;
      }
      core.debug(`cannot access to ${value} ${JSON.stringify(stat ?? "{}")}`);
      return false;
    })
    .reduce((acc: { [name: string]: string }, cur: string[]) => {
      acc[cur[0]] = cur[1];
      return acc;
    }, {});
};

const detectCdkOutputs = async (dir: string) => {
  const buf = await fs.promises.readFile(`${dir}/manifest.json`, "utf-8");
  const artifacts = JSON.parse(buf).artifacts;
  const pairs = Object.entries<{
    type: string;
    properties: { templateFile: string };
  }>(artifacts)
    .filter(([_, value]) => {
      return value["type"] === "aws:cloudformation:stack";
    })
    .map(([name, value]) => {
      return [name, path.join(dir, value.properties.templateFile)];
    });
  return toAccessibleTemplates(pairs);
};

export const getCurrentTemplate = async (
  client: CloudFormationClient,
  name: string
) => {
  const response = await client.send(
    new GetTemplateCommand({ StackName: name })
  );
  return JSON.parse(response.TemplateBody ?? "{}") as CfnTemplate;
};

export const detectStackDriftStatus = async (
  client: CloudFormationClient,
  activeStacks: string[]
): Promise<{ [name: string]: StackDriftStatus }> => {
  const result: { [name: string]: StackDriftStatus } = {};

  const tickets: { [name: string]: string } = {};
  for (const StackName of activeStacks) {
    const response = await client.send(
      new DetectStackDriftCommand({ StackName })
    );
    const id = response.StackDriftDetectionId;
    if (id) {
      tickets[StackName] = id;
    }
  }
  core.debug(`drift tickets ${JSON.stringify(tickets)}`);

  for (const [name, id] of Object.entries(tickets)) {
    result[name] = await describeDriftingStatus(client, name, id);
  }
  core.debug(`drift result ${JSON.stringify(result)}`);

  return result;
};

const describeDriftingStatus = async (
  client: CloudFormationClient,
  name: string,
  StackDriftDetectionId: string
) => {
  try {
    return await retry(
      async (): Promise<StackDriftStatus> => {
        const response = await client.send(
          new DescribeStackDriftDetectionStatusCommand({
            StackDriftDetectionId,
          })
        );
        if (
          response.DetectionStatus ===
          StackDriftDetectionStatus.DETECTION_COMPLETE
        ) {
          switch (response.StackDriftStatus) {
            case StackDriftStatus.DRIFTED:
              return StackDriftStatus.DRIFTED;
            case StackDriftStatus.IN_SYNC:
              return StackDriftStatus.IN_SYNC;
            case StackDriftStatus.NOT_CHECKED:
              return StackDriftStatus.NOT_CHECKED;
            default:
              core.debug(
                `unknown drift status ${response.StackDriftStatus} of ${name}`
              );
              return StackDriftStatus.UNKNOWN;
          }
        }
        if (
          response.DetectionStatus ===
          StackDriftDetectionStatus.DETECTION_FAILED
        ) {
          core.debug(`fail to detect drift status of ${name}`);
          return StackDriftStatus.UNKNOWN;
        }

        if (
          response.DetectionStatus ===
          StackDriftDetectionStatus.DETECTION_IN_PROGRESS
        ) {
          core.debug(`retry describe StackDriftDetectionStatus of ${name}`);
          // continue request
          throw {
            abort: false,
          };
        }
        throw {
          abort: true,
        };
      },
      {
        delay: parseNumberConfig("drift-delay-milliseconds", 3 * 1000),
        factor: 2,
        maxAttempts: parseNumberConfig("drift-maxAttempts", 7),
        jitter: true,
        timeout: parseNumberConfig("drift-timeout-milliseconds", 6 * 60 * 1000),
        handleError(err: { abort: boolean }, context: AttemptContext) {
          if (err.abort) {
            context.abort();
          }
        },
      }
    );
  } catch (error) {
    if (error instanceof Error) {
      core.error(error);
    } else {
      core.debug(JSON.stringify(error));
    }
    core.debug(`fail to describe StackDriftDetectionStatus of ${name}`);
    return StackDriftStatus.UNKNOWN;
  }
};

const parseNumberConfig = (name: string, defaultValue: number): number => {
  const value = core.getInput(name);
  const result = parseInt(value);
  return result ?? defaultValue;
};

export const listStackResources = async (
  client: CloudFormationClient,
  name: string
) => {
  const response = await client.send(
    new ListStackResourcesCommand({ StackName: name })
  );
  return response.StackResourceSummaries ?? [];
};

export type CfnTemplate = {
  Resources: {
    [logicalId: string]: CfnResource;
  };
};

export type CfnResource = {
  Type: string;
  Properties: {
    [name: string]: unknown;
  };
  Metadata: {
    [name: string]: unknown;
  };
};

export const parseTemplate = async (filepath: string): Promise<CfnTemplate> => {
  const buf = await fs.promises.readFile(filepath, "utf-8");
  const lower = filepath.toLowerCase();
  if (lower.endsWith(".json")) {
    return JSON.parse(buf) as CfnTemplate;
  } else if (lower.endsWith(".yml") || lower.endsWith(".yaml")) {
    return yaml.load(buf) as CfnTemplate;
  } else {
    throw new Error(`Unsupported file type ${filepath}`);
  }
};

export const detectDriftStatus = (
  stackStatus: StackDriftStatus,
  currentResources: StackResourceSummary[]
) => {
  if (stackStatus === StackDriftStatus.DRIFTED) {
    return stackStatus;
  }
  const res = currentResources.find((resource) => {
    const status = resource.DriftInformation?.StackResourceDriftStatus;
    return (
      status === StackResourceDriftStatus.MODIFIED ||
      status === StackResourceDriftStatus.DELETED
    );
  });
  return res ? StackDriftStatus.DRIFTED : StackDriftStatus.UNKNOWN;
};
