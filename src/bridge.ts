#!/usr/bin/env node

import { startBridgeServer } from "./bridge-runtime.js";
import { isCliUsageError, runMcpCli } from "./cli.js";

const args = process.argv.slice(2);

void (args.length === 0
  ? startBridgeServer()
  : runMcpCli(args).then((exitCode) => {
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    })
).catch((error) => {
  if (isCliUsageError(error)) {
    console.error(error.message);
    process.exit(error.exitCode);
  }
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
