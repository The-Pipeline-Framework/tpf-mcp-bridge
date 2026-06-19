/*
 * Copyright (c) 2023-2025 Mariano Barcia
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultSource = path.resolve(
  repoRoot,
  "../pipelineframework/framework/deployment/target/classes/META-INF/pipeline/pipeline-template-schema.json",
);
const source = path.resolve(process.argv[2] || process.env.TPF_PIPELINE_SCHEMA_PATH || defaultSource);
const destination = path.join(repoRoot, "template-generator-node/src/pipeline-template-schema.json");

const sourceText = normalize(fs.readFileSync(source, "utf8"));
const destinationText = normalize(fs.readFileSync(destination, "utf8"));

if (sourceText !== destinationText) {
  throw new Error(
    `Vendored pipeline schema is out of sync with ${source}. ` +
    "Run npm run sync:pipeline-schema -- <exported-schema-path> and commit the updated snapshot."
  );
}

console.log(`Vendored pipeline template schema matches ${source}`);

function normalize(value) {
  return `${value.trimEnd()}\n`;
}
