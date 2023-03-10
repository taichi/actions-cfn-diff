import * as core from "@actions/core";

import { processCloudFormation } from "./cloudformation";

async function run(): Promise<void> {
  try {
    changeDir();
    processCloudFormation();
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

run();
