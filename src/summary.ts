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
  StackDriftStatus,
  StackResourceDriftStatus,
  StackResourceSummary,
} from "@aws-sdk/client-cloudformation";
import Convert = require("ansi-to-html");

import { CfnTemplate, CfnResource } from "./cloudformation";
import { postComment } from "./comment";

const region = core.getInput("aws-region");
const urlPrefix = `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks`;

export const writeSummary = async (stackName: string, target: CfnTemplate) => {
  core.debug(`writeSummary ${stackName}`);

  const sum = core.summary.addHeading(`:books: ${stackName} Stack Resources`);

  sum.addHeading("Resource List", 2);
  const headers: SummaryTableRow[] = [
    [
      { data: "Type", header: true },
      { data: "Logical ID", header: true },
      { data: "Physical ID", header: true },
    ],
  ];
  const values = Object.entries(target.Resources)
    .sort(resourceComparator)
    .filter(([_, value]) => value.Type !== "AWS::CDK::Metadata")
    .map(([id, value]) => [value.Type, id, findNameLike(value.Properties)]);

  if (0 < values.length) {
    sum.addTable(headers.concat(values));
  } else {
    sum.addHeading("There are no resources.", 3);
  }

  await postContents(sum);
};

export const writeDifferenceSummary = async (
  stackName: string,
  stackId: string,
  current: CfnTemplate,
  target: CfnTemplate,
  currentResources: StackResourceSummary[]
) => {
  core.debug(`writeDifferenceSummary ${stackName} ${stackId}`);

  const diff = await diffTemplate(current, target);

  const stackUrl = `${urlPrefix}/stackinfo?stackId=${encodeURI(stackId)}`;
  const sum = core.summary.addHeading(
    `:books: <a href="${stackUrl}">${stackName} Stack</a> Resources`
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
          findName(target.Resources[id].Properties, resource),
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

  await postContents(sum);
};

export const writeDifferenceSummaryWithDrift = async (
  stackName: string,
  stackId: string,
  current: CfnTemplate,
  target: CfnTemplate,
  currentResources: StackResourceSummary[],
  drift: StackDriftStatus
) => {
  core.debug(`writeDifferenceSummaryWithDrift ${stackName} ${stackId}`);

  const diff = await diffTemplate(current, target);

  const stackUrl = `${urlPrefix}/stackinfo?stackId=${encodeURI(stackId)}`;
  const sum = core.summary.addHeading(
    `:books: <a href="${stackUrl}">${stackName} Stack</a> Resources`
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
        impact === ResourceImpact.NO_CHANGE &&
        (drift === StackResourceDriftStatus.NOT_CHECKED ||
          drift === StackResourceDriftStatus.IN_SYNC)
      ) {
        return;
      }

      return [
        renderChangeImpact(impact),
        renderDriftStatus(drift),
        target.Resources[id].Type,
        id,
        findName(target.Resources[id].Properties, resource),
      ];
    }
  );

  if (0 < values.length) {
    sum.addTable(headers.concat(values));
  } else {
    sum.addHeading("There no changes.", 3);
  }

  renderDetails(sum, diff);

  await postContents(sum);
};

const findNameLike = (props: { [name: string]: unknown }) => {
  const names = Object.entries(props)
    .filter(([name]) => name.endsWith("Name"))
    .filter(([_, value]) => typeof value === "string")
    .map(([_, value]) => value as string);
  return 0 < names.length ? names[0] : "";
};

const findName = (
  props: { [name: string]: unknown },
  sum: StackResourceSummary
) => {
  const name = findNameLike(props);
  if (name) {
    return name;
  }
  return sum.PhysicalResourceId ?? "";
};

const resourceComparator = (
  left: [name: string, res: CfnResource],
  right: [name: string, res: CfnResource]
) => {
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
};

const renderChangeImpact = (impact?: ResourceImpact) => {
  switch (impact) {
    case ResourceImpact.WILL_UPDATE:
      return ":speech_balloon: Update";
    case ResourceImpact.WILL_CREATE:
      return ":sparkles: Create";
    case ResourceImpact.WILL_REPLACE:
      return ":hammer_and_wrench: Replace";
    case ResourceImpact.MAY_REPLACE:
      return ":wrench: May Replace";
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
      return ":see_no_evil: NOT_CHECKED";
    default:
      return "";
  }
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
    const pr: number =
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

const postContents = async (sum: typeof core.summary) => {
  await sum.write();
  await postComment();
};
