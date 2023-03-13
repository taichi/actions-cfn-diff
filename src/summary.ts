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
  StackResourceDriftStatus,
  StackResourceSummary,
} from "@aws-sdk/client-cloudformation";
import stripAnsi from "strip-ansi";

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
    .map(([id, value]) => [value.Type, id, findNameLike(value.Properties, "")]);

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

  core.debug(
    "current=> " +
      Object.keys(current.Resources)
        .sort((a, b) => a.localeCompare(b))
        .join(" ")
  );
  core.debug(
    "target=> " +
      Object.keys(target.Resources)
        .sort((a, b) => a.localeCompare(b))
        .join(" ")
  );
  const diff = await diffTemplate(current, target);
  core.debug(`diff=> ${diff.resources.differenceCount}`);

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

  const values: string[][] = [];
  diff.resources.forEachDifference((id, change) => {
    const physicalId =
      currentResources.find((r) => r.LogicalResourceId == id)
        ?.PhysicalResourceId ?? "";
    values.push([
      renderChangeImpact(change.changeImpact),
      change.resourceType,
      id,
      findNameLike(change.newProperties ?? {}, physicalId),
    ]);
  });

  if (0 < values.length) {
    values.sort((left, right) => {
      const tr: number = left[1].localeCompare(right[1]);
      if (tr !== 0) {
        return tr;
      }
      const pr = left[3].localeCompare(right[3]);
      if (pr !== 0) {
        return pr;
      }
      return left[2].localeCompare(right[2]);
    });
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
  currentResources: StackResourceSummary[]
) => {
  core.debug(`writeDifferenceSummaryWithDrift ${stackName} ${stackId}`);

  core.debug(
    "current=> " +
      Object.keys(current.Resources)
        .sort((a, b) => a.localeCompare(b))
        .join(" ")
  );
  core.debug(
    "target=> " +
      Object.keys(target.Resources)
        .sort((a, b) => a.localeCompare(b))
        .join(" ")
  );
  const diff = await diffTemplate(current, target);
  core.debug(`diff=> ${JSON.stringify(diff.resources.differenceCount)}`);

  const stackUrl = `${urlPrefix}/stackinfo?stackId=${encodeURI(stackId)}`;
  const sum = core.summary.addHeading(
    `:books: <a href="${stackUrl}">${stackName} Stack</a> Resources`
  );

  if (findDriftedChanges(diff, currentResources)) {
    const driftUrl = `${urlPrefix}/drifts?stackId=${encodeURI(stackId)}`;
    sum.addHeading(
      `:fire: <a href="${driftUrl}">Drifted Resource Updated</a> :fire:`,
      3
    );
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

  const values: string[][] = [];
  diff.resources.forEachDifference((id, change) => {
    const resource = currentResources.find((r) => r.LogicalResourceId == id);
    const physicalId = resource?.PhysicalResourceId ?? "";
    const drift = resource?.DriftInformation?.StackResourceDriftStatus;
    values.push([
      renderChangeImpact(change.changeImpact),
      renderDriftStatus(drift),
      change.resourceType,
      id,
      findNameLike(change.newProperties ?? {}, physicalId),
    ]);
  });

  if (0 < values.length) {
    values.sort((left, right) => {
      const tr = left[2].localeCompare(right[2]);
      if (tr !== 0) {
        return tr;
      }
      const pr = left[4].localeCompare(right[4]);
      if (pr !== 0) {
        return pr;
      }
      return left[3].localeCompare(right[3]);
    });
    sum.addTable(headers.concat(values));
  } else {
    sum.addHeading("There are no changes.", 3);
  }

  renderDetails(sum, diff);

  await postContents(sum);
};

const findNameLike = (
  props: { [name: string]: unknown },
  candidate: string
) => {
  const names = Object.entries(props)
    .filter(([name]) => name.endsWith("Name"))
    .filter(([_, value]) => typeof value === "string")
    .map(([_, value]) => value as string);
  return 0 < names.length ? names[0] : candidate;
};

const resourceComparator = (
  left: [name: string, res: CfnResource],
  right: [name: string, res: CfnResource]
) => {
  const result = left[1].Type.localeCompare(right[1].Type);
  if (result !== 0) {
    return result;
  }
  const leftName = findNameLike(left[1].Properties, "");
  const rightName = findNameLike(right[1].Properties, "");
  const nr = leftName.localeCompare(rightName);
  if (nr !== 0) {
    return nr;
  }
  return left[0].localeCompare(right[0]);
};

const findDriftedChanges = (
  diff: TemplateDiff,
  currentResources: StackResourceSummary[]
) => {
  const found = [];
  diff.resources.forEachDifference((id) => {
    const resource = currentResources.find((r) => r.LogicalResourceId == id);
    const status = resource?.DriftInformation?.StackResourceDriftStatus;
    if (
      status !== StackResourceDriftStatus.IN_SYNC &&
      status !== StackResourceDriftStatus.NOT_CHECKED
    ) {
      found.push(resource);
    }
  });
  return 0 < found.length;
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
  return stripAnsi(Buffer.concat(chunks).toString("utf-8"));
};

const renderDetails = (sum: typeof core.summary, diff: TemplateDiff) => {
  const rd = renderAnsiCodeToHtml((stream) => formatDifferences(stream, diff));
  if (rd) {
    sum.addDetails("Resource Difference", `<pre>${rd}</pre>`);
  }

  const sc = renderAnsiCodeToHtml((stream) => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore https://github.com/aws/aws-cdk/pull/24537
    formatSecurityChanges(stream, diff);
  });
  if (sc) {
    sum.addDetails("Security Changes", `<pre>${sc}</pre>`);
  }
};

const postContents = async (sum: typeof core.summary) => {
  await sum.write();
  await postComment();
};
