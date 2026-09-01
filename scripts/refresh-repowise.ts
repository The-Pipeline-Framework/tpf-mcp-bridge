import path from "node:path";

import {
  requestRepowiseRefresh,
  runQueuedRefreshes,
} from "../src/repowise-refresh.js";

const args = parseArgs(process.argv.slice(2));
try {
  requestRepowiseRefresh(args.stateDir, args.commit);
} catch (error) {
  console.warn(
    `Repowise refresh request was not queued: ${error instanceof Error ? error.message : String(error)}`,
  );
}
runQueuedRefreshes(args.stateDir);

function parseArgs(values: string[]): { stateDir: string; commit: string } {
  let stateDir = "";
  let commit = "";
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--state-dir")
      stateDir = path.resolve(requireValue(values, ++index, value));
    else if (value === "--commit")
      commit = requireValue(values, ++index, value);
    else throw new Error(`Unknown argument '${value}'`);
  }
  if (stateDir === "" || commit === "") {
    throw new Error(
      "Usage: tsx scripts/refresh-repowise.ts --state-dir <directory> --commit <full-sha>",
    );
  }
  return { stateDir, commit };
}

function requireValue(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`Missing value for ${flag}`);
  return value;
}
