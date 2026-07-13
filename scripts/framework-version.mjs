import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const GENERATED_FRAMEWORK_VERSION = "26.6.2";

export function alignGeneratedFrameworkVersion(outputDir, frameworkDir) {
  const frameworkVersion = readFrameworkVersion(frameworkDir);
  const updatedPomCount = replaceGeneratedVersions(outputDir, frameworkVersion);
  console.log(`Aligned ${updatedPomCount} generated POMs with framework ${frameworkVersion}`);
}

function readFrameworkVersion(frameworkDir) {
  const pom = readFileSync(path.join(frameworkDir, "pom.xml"), "utf8");
  const match = pom.match(/<version>\s*([^<\s]+)\s*<\/version>/);
  if (!match) {
    throw new Error(`Unable to determine the framework version from ${path.join(frameworkDir, "pom.xml")}`);
  }
  return match[1];
}

function replaceGeneratedVersions(directory, frameworkVersion) {
  let updatedPomCount = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      updatedPomCount += replaceGeneratedVersions(entryPath, frameworkVersion);
      continue;
    }
    if (entry.name !== "pom.xml") {
      continue;
    }
    const pom = readFileSync(entryPath, "utf8");
    const updatedPom = pom.replaceAll(GENERATED_FRAMEWORK_VERSION, frameworkVersion);
    if (updatedPom !== pom) {
      writeFileSync(entryPath, updatedPom);
      updatedPomCount += 1;
    }
  }
  return updatedPomCount;
}
