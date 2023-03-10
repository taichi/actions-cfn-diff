import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { PassThrough } from "stream";
import * as core from "@actions/core";
import { SummaryTableRow } from "@actions/core/lib/summary";
import {
  diffTemplate,
  formatDifferences,
  formatSecurityChanges,
  ResourceImpact,
  TemplateDiff,
} from "@aws-cdk/cloudformation-diff";
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
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { retry, AttemptContext } from "@lifeomic/attempt";
import Convert = require("ansi-to-html");
import * as yaml from "js-yaml";

const region = core.getInput("aws-region");
const urlPrefix = `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks`;

async function run(): Promise<void> {
  try {
    changeDir();

    const targets = await detectTargets();
    core.debug(`targets ${JSON.stringify(Object.keys(targets))}`);

    const client = await createCfnClient();
    const stacks = await listStacks(client, (value) => {
      return !!(value.StackName && targets[value.StackName]);
    });

    const currentStacks = stacks.map((value) => value.StackName || "");

    const autoDrift = core.getBooleanInput("enable-drift-detection");
    const driftStatus = autoDrift
      ? await detectDriftingStatus(client, currentStacks)
      : {};

    for (const [name, filepath] of Object.entries(targets)) {
      const target = await parseTemplate(filepath);
      if (currentStacks.includes(name)) {
        const current = await getCurrentTemplate(client, name);
        const diff = await diffTemplate(current, target);
        const resources = await listStackResources(client, name);

        const stackId =
          stacks.find((stack) => {
            return stack.StackName === name;
          })?.StackId ?? "";

        if (autoDrift) {
          const drift = driftStatus[name];
          await writeDifferenceSummaryWithDrift(
            name,
            stackId,
            target,
            resources,
            diff,
            drift
          );
        } else {
          await writeDifferenceSummary(name, stackId, target, resources, diff);
        }
      } else {
        await writeSummary(name, target);
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(JSON.stringify(error));
    }
  }
}

const changeDir = () => {
  const dir = core.getInput("working-directory");
  if (dir) {
    core.debug(`change to working dir ${dir}`);
    process.chdir(dir);
  }
};

const createCfnClient = async () => {
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

const listStacks = async (
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

const detectTargets = async () => {
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
    const values = detectCdkOutputs(cdkDir);
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
      core.debug(`cannot access to ${value} ${stat ?? JSON.stringify(stat)}`);
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

const getCurrentTemplate = async (
  client: CloudFormationClient,
  name: string
) => {
  const response = await client.send(
    new GetTemplateCommand({ StackName: name })
  );
  return JSON.parse(response.TemplateBody ?? "{}");
};

const parseTemplate = async (filepath: string): Promise<CfnTemplate> => {
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

const detectDriftingStatus = async (
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
              core.info(
                `unknown drift status ${response.StackDriftStatus} of ${name}`
              );
              return StackDriftStatus.UNKNOWN;
          }
        }
        if (
          response.DetectionStatus ===
          StackDriftDetectionStatus.DETECTION_FAILED
        ) {
          core.error(`fail to detect drift status of ${name}`);
          return StackDriftStatus.UNKNOWN;
        }

        if (
          response.DetectionStatus ===
          StackDriftDetectionStatus.DETECTION_IN_PROGRESS
        ) {
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
        maxAttempts: parseNumberConfig("drift-maxAttempts", 5),
        jitter: true,
        timeout: parseNumberConfig("drift-timeout-milliseconds", 5 * 60 * 1000),
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
    }
    core.info(`fail to describe StackDriftDetectionStatus of ${name}`);
    return StackDriftStatus.UNKNOWN;
  }
};

const parseNumberConfig = (name: string, defaultValue: number): number => {
  const value = core.getInput(name);
  const result = parseInt(value);
  return result ?? defaultValue;
};

const listStackResources = async (
  client: CloudFormationClient,
  name: string
) => {
  const response = await client.send(
    new ListStackResourcesCommand({ StackName: name })
  );
  return response.StackResourceSummaries ?? [];
};

type CfnTemplate = {
  Resources: {
    [logicalId: string]: {
      Type: string;
      Properties: {
        [name: string]: unknown;
      };
      Metadata: {
        [name: string]: unknown;
      };
    };
  };
};

const findNameLike = (props: { [name: string]: unknown }) => {
  const names = Object.entries(props)
    .filter(([name]) => name.endsWith("Name"))
    .filter(([_, value]) => typeof value === "string")
    .map(([_, value]) => value as string);
  return 0 < names.length ? names[0] : "";
};

const writeSummary = async (stackName: string, target: CfnTemplate) => {
  core.debug(`writeSummary ${stackName}`);

  const sum = core.summary.addHeading(`${stackName} Stack Resources`);

  sum.addHeading("Resource List", 2);
  const headers: SummaryTableRow[] = [
    [
      { data: "Type", header: true },
      { data: "Logical ID", header: true },
      { data: "Physical ID", header: true },
    ],
  ];
  const values = Object.entries(target.Resources)
    .sort((left, right) => {
      const result = left[1].Type.localeCompare(right[1].Type);
      if (result !== 0) {
        return result;
      }
      const leftName = findNameLike(left[1].Properties);
      const rightName = findNameLike(right[1].Properties);
      const nr = leftName.localeCompare(rightName);
      if (nr !== 0) {
        return nr;
      }
      return left[0].localeCompare(right[0]);
    })
    .filter(([_, value]) => value.Type !== "AWS::CDK::Metadata")
    .map(([id, value]) => {
      return [value.Type, id, findNameLike(value.Properties)];
    });

  if (0 < values.length) {
    sum.addTable(headers.concat(values));
  } else {
    sum.addHeading("There are no resources.", 3);
  }

  await sum.write();
};

const renderAnsiCodeToHtml = (fn: (stream: PassThrough) => void): string => {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk));
  });
  fn(stream);
  const convert = new Convert();
  return convert.toHtml(Buffer.concat(chunks).toString("utf-8"));
};

const renderChangeImpact = (impact?: ResourceImpact) => {
  switch (impact) {
    case ResourceImpact.WILL_UPDATE:
      return ":speech_balloon: Update";
    case ResourceImpact.WILL_CREATE:
      return ":sparkles: Create";
    case ResourceImpact.WILL_REPLACE:
      return ":green_book: Replace";
    case ResourceImpact.MAY_REPLACE:
      return ":blue_book: May Replace";
    case ResourceImpact.WILL_DESTROY:
      return ":bomb: Destroy";
    case ResourceImpact.WILL_ORPHAN:
      return ":ghost: Orphan";
    case ResourceImpact.NO_CHANGE:
      return "";
    default:
      return "";
  }
};

const writeDifferenceSummary = async (
  stackName: string,
  stackId: string,
  target: CfnTemplate,
  currentResources: StackResourceSummary[],
  diff: TemplateDiff
) => {
  core.debug(`writeDifferenceSummary ${stackName} ${stackId}`);

  const stackUrl = `${urlPrefix}/stackinfo?stackId=${encodeURI(stackId)}`;
  const sum = core.summary.addHeading(
    `<a href="${stackUrl}">${stackName} Stack</a> Resources`
  );

  const headers: SummaryTableRow[] = [
    [
      { data: "Diff", header: true },
      { data: "Type", header: true },
      { data: "Logical ID", header: true },
      { data: "Physical ID", header: true },
    ],
  ];

  const values = processResources(
    currentResources,
    (id: string, resource: StackResourceSummary) => {
      const impact = diff.resources.get(id).changeImpact;
      if (impact !== ResourceImpact.NO_CHANGE) {
        return [
          renderChangeImpact(impact),
          target.Resources[id].Type,
          id,
          resource.PhysicalResourceId ?? "",
        ];
      }
    }
  );

  if (0 < values.length) {
    sum.addTable(headers.concat(values));
  } else {
    sum.addHeading("There are no changes.", 3);
  }

  renderDetails(sum, diff);

  await sum.write();
};

const processResources = (
  currentResources: StackResourceSummary[],
  fn: (
    id: string,
    resource: StackResourceSummary
  ) => SummaryTableRow | undefined
): SummaryTableRow[] => {
  const values: SummaryTableRow[] = [];
  currentResources.sort((left, right) => {
    const tr = left.ResourceType?.localeCompare(right.ResourceType || "") ?? 0;
    if (tr !== 0) {
      return tr;
    }
    const pr =
      left.PhysicalResourceId?.localeCompare(right.PhysicalResourceId || "") ??
      0;
    if (pr !== 0) {
      return pr;
    }
    return (
      left.LogicalResourceId?.localeCompare(right.LogicalResourceId || "") ?? 0
    );
  });
  for (const resource of currentResources) {
    if (resource.ResourceType === "AWS::CDK::Metadata") {
      continue;
    }
    const id = resource.LogicalResourceId;
    if (id) {
      const row = fn(id, resource);
      if (row) {
        values.push(row);
      }
    }
  }
  return values;
};

const renderDetails = (sum: typeof core.summary, diff: TemplateDiff) => {
  const rd = renderAnsiCodeToHtml((stream) => formatDifferences(stream, diff));
  sum.addDetails("Resource Difference", `<pre>${rd}</pre>`);

  const sc = renderAnsiCodeToHtml((stream) => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore https://github.com/aws/aws-cdk/pull/24537
    formatSecurityChanges(stream, diff);
  });
  if (sc) {
    sum.addDetails("Security Changes", `<pre>${sc}</pre>`);
  }
};

const renderDriftStatus = (
  status: StackResourceDriftStatus | string | undefined
) => {
  switch (status) {
    case StackResourceDriftStatus.DELETED:
      return ":bomb: DELETED";
    case StackResourceDriftStatus.IN_SYNC:
      return ":heavy_check_mark: IN_SYNC";
    case StackResourceDriftStatus.MODIFIED:
      return ":fire: MODIFIED";
    case StackResourceDriftStatus.NOT_CHECKED:
      return "";
    default:
      return "";
  }
};

const writeDifferenceSummaryWithDrift = async (
  stackName: string,
  stackId: string,
  target: CfnTemplate,
  currentResources: StackResourceSummary[],
  diff: TemplateDiff,
  drift: StackDriftStatus
) => {
  core.debug(`writeDifferenceSummaryWithDrift ${stackName} ${stackId}`);

  const stackUrl = `${urlPrefix}/stackinfo?stackId=${encodeURI(stackId)}`;
  const sum = core.summary.addHeading(
    `<a href="${stackUrl}">${stackName} Stack</a> Resources`
  );

  if (drift === StackDriftStatus.DRIFTED) {
    const driftUrl = `${urlPrefix}/drifts?stackId=${encodeURI(stackId)}`;
    sum.addHeading(`:fire: <a href="${driftUrl}">Drift Detected</a> :fire:`, 3);
  }

  const headers: SummaryTableRow[] = [
    [
      { data: "Diff", header: true },
      { data: "Drift", header: true },
      { data: "Type", header: true },
      { data: "Logical ID", header: true },
      { data: "Physical ID", header: true },
    ],
  ];

  const values = processResources(
    currentResources,
    (id: string, resource: StackResourceSummary) => {
      const impact = diff.resources.get(id).changeImpact;
      const drift = resource.DriftInformation?.StackResourceDriftStatus;

      if (
        impact !== ResourceImpact.NO_CHANGE &&
        drift &&
        drift !== StackResourceDriftStatus.NOT_CHECKED
      ) {
        return [
          renderChangeImpact(impact),
          renderDriftStatus(drift),
          target.Resources[id].Type,
          id,
          resource.PhysicalResourceId ?? "",
        ];
      }
    }
  );

  if (0 < values.length) {
    sum.addTable(headers.concat(values));
  } else {
    sum.addHeading("There no changes.", 3);
  }

  renderDetails(sum, diff);

  await sum.write();
};

run();
