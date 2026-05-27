#!/usr/bin/env node

import { startBridgeServer } from "./bridge-runtime.js";

void startBridgeServer().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
