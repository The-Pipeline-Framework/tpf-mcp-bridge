import { execFileSync } from "node:child_process";
import path from "node:path";

import { classifyAuthorPath } from "../src/publication.js";

const options = parseArgs(process.argv.slice(2));
const diff = execFileSync(
  "git",
  ["diff", "--name-status", `${options.from}..${options.to}`],
  {
    cwd: options.frameworkDir,
    encoding: "utf8",
  },
);
const changes = diff
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const fields = line.split("\t");
    const filePath = fields.at(-1) ?? "";
    return {
      status: fields[0],
      path: filePath,
      scope: classifyAuthorPath(filePath),
    };
  });
const included = changes.filter((change) => change.scope !== undefined);
const review = changes.filter(
  (change) =>
    change.scope === undefined &&
    /^(docs\/|framework\/(?:api|runtime-core|runtime|connectors|plugins)\/|examples\/|\.agents\/)/.test(
      change.path,
    ),
);

console.log(`# TPF author knowledge parity: ${options.from}..${options.to}\n`);
console.log(`- Author knowledge changes: ${included.length}`);
console.log(
  `- Excluded high-signal changes requiring scope review: ${review.length}`,
);
for (const change of included)
  console.log(`- [${change.scope}] ${change.status} ${change.path}`);
if (review.length > 0) {
  console.log("\n## Scope review required\n");
  for (const change of review) console.log(`- ${change.status} ${change.path}`);
  process.exitCode = 2;
}

function parseArgs(values: string[]) {
  const parsed = { frameworkDir: "", from: "", to: "HEAD" };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--framework-dir")
      parsed.frameworkDir = path.resolve(requireValue(values, ++index, value));
    else if (value === "--from")
      parsed.from = requireValue(values, ++index, value);
    else if (value === "--to") parsed.to = requireValue(values, ++index, value);
    else throw new Error(`Unknown argument '${value}'`);
  }
  if (!parsed.frameworkDir || !parsed.from) {
    throw new Error(
      "Usage: tsx scripts/audit-release-parity.ts --framework-dir <checkout> --from <tag> [--to <tag>]",
    );
  }
  return parsed;
}

function requireValue(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`Missing value for ${flag}`);
  return value;
}
