import * as core from "@actions/core";
import * as github from "@actions/github";

export const postComment = async () => {
  const client = github.getOctokit(core.getInput("github-token"));

  const prNumber = github.context.payload.pull_request?.number;
  if (!prNumber) {
    return;
  }

  const repo = github.context.repo;

  const commentBody = `:books: [CloudFormation Resource Summary](https://github.com/${repo.owner}/${repo.repo}/actions/runs/${github.context.runId}) is reported.`;

  for await (const { data: comments } of client.paginate.iterator(
    client.rest.issues.listComments,
    {
      ...repo,
      issue_number: prNumber,
    }
  )) {
    const found = comments
      .filter((cmt) => cmt.user?.login === "github-actions[bot]")
      .filter((cmt) => cmt.body?.includes(commentBody));
    if (found && 0 < found.length) {
      return;
    }
  }

  try {
    await client.rest.issues.createComment({
      ...github.context.repo,
      issue_number: prNumber,
      body: commentBody,
    });
  } catch (error) {
    if (error instanceof Error) {
      core.warning(error);
    } else {
      core.warning(JSON.stringify(error));
    }
    core.warning("set permissions of pull-requests to write.");
  }
};
