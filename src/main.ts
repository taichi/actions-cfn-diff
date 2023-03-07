import * as core from "@actions/core";

async function run(): Promise<void> {
  try {
    const dir: string = core.getInput("working-dir");
    core.debug(`change to working dir ${dir}`);

    process.chdir(dir);

    core.setOutput("dir", process.cwd());
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message);
  }
}

run();
