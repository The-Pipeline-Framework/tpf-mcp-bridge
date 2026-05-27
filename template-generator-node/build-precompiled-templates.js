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

const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

const templatesDir = path.join(__dirname, './templates');
const outputPath = path.join(__dirname, './src/template-bundle-precompiled.js');

let templateFiles;
try {
    templateFiles = fs.readdirSync(templatesDir);
} catch (error) {
    console.error(`Error reading templates directory '${templatesDir}': ${error.message}`);
    process.exit(1);
}

const entries = [];
for (const file of templateFiles) {
    if (!file.endsWith('.hbs')) {
        continue;
    }
    try {
        const templateName = path.basename(file, '.hbs');
        const templateContent = fs.readFileSync(path.join(templatesDir, file), 'utf8');
        const precompiled = Handlebars.precompile(templateContent);
        entries.push(`  ${JSON.stringify(templateName)}: ${precompiled}`);
    } catch (error) {
        console.error(`Error precompiling template file ${file}: ${error.message}`);
        process.exit(1);
    }
}

if (entries.length === 0) {
    console.error(`Warning: No .hbs template files found in directory '${templatesDir}'`);
    process.exit(1);
}

const jsContent = `/* Auto-generated precompiled template collection. */\nmodule.exports = {\n${entries.join(',\n')}\n};\n`;

try {
    fs.writeFileSync(outputPath, jsContent);
} catch (error) {
    console.error(`Error writing output file ${outputPath}: ${error.message}`);
    process.exit(1);
}

console.log('Templates have been precompiled into src/template-bundle-precompiled.js');
