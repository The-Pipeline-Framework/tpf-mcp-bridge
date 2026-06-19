import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import YAML from "js-yaml";
import JSZip from "jszip";
import { assertCompositionManifestInvariants, assertDerivedConfigInvariants } from "./derived-config-validation.js";
import type { DerivedConfig, PipelineCompositionManifest } from "./types.js";

const require = createRequire(import.meta.url);
const packageRoot = resolvePackageRoot();
const PipelineGenerator = require(resolveVendoredModulePath("pipeline-generator.js"));
const BrowserTemplateEngine = require(resolveVendoredModulePath("browser-template-engine.js"));
const templateBundle = require(resolveVendoredModulePath("template-bundle.js"));

type FileContent = string;
type FileCallback = (filePath: string, content: FileContent) => Promise<void> | void;

interface PipelineGeneratorInstance {
  saveConfig(config: DerivedConfig, outputPath: string): Promise<void>;
  loadConfig(configPath: string): DerivedConfig;
  toScaffoldConfig(config: DerivedConfig): {
    appName: string;
    basePackage: string;
    steps: Array<Record<string, unknown>>;
    aspects?: Record<string, unknown>;
    unionDefinitions?: Array<Record<string, unknown>>;
    transport?: string;
    platform?: string;
    runtimeLayout?: string;
  };
}

interface BrowserTemplateEngineInstance {
  generateApplication(options: {
    appName: string;
    basePackage: string;
    steps: Array<Record<string, unknown>>;
    aspects?: Record<string, unknown>;
    unionDefinitions?: Array<Record<string, unknown>>;
    transport?: string;
    platform?: string;
    runtimeLayout?: string;
    fileCallback: FileCallback;
  }): Promise<void>;
}

export async function validateDerivedConfig(config: DerivedConfig): Promise<DerivedConfig> {
  assertDerivedConfigInvariants(config);
  const generator = new PipelineGenerator() as PipelineGeneratorInstance;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tpf-mcp-validate-"));
  try {
    const configPath = path.join(tempDir, "pipeline.yaml");
    await generator.saveConfig(config, configPath);
    const loaded = generator.loadConfig(configPath);
    assertDerivedConfigInvariants(loaded);
    generator.toScaffoldConfig(loaded);
    return loaded;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function generateScaffold(
  config: DerivedConfig,
  outputDir: string,
  compositionManifest?: PipelineCompositionManifest
): Promise<string> {
  const resolvedOutput = path.isAbsolute(outputDir) ? outputDir : path.resolve(process.cwd(), outputDir);
  await generateScaffoldFiles(config, async (filePath, content) => {
    const targetPath = path.join(resolvedOutput, filePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, "utf8");
  }, compositionManifest);
  return resolvedOutput;
}

export async function generateScaffoldZip(
  config: DerivedConfig,
  compositionManifest?: PipelineCompositionManifest
): Promise<Uint8Array> {
  const zip = new JSZip();
  await generateScaffoldFiles(config, async (filePath, content) => {
    zip.file(filePath, content);
  }, compositionManifest);
  return zip.generateAsync({ type: "uint8array" });
}

export async function generateScaffoldFiles(
  config: DerivedConfig,
  fileCallback: FileCallback,
  compositionManifest?: PipelineCompositionManifest
): Promise<void> {
  assertDerivedConfigInvariants(config);
  assertCompositionManifestInvariants(compositionManifest);
  const generator = new PipelineGenerator() as PipelineGeneratorInstance;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tpf-mcp-shared-generate-"));
  try {
    const configPath = path.join(tempDir, "pipeline.yaml");
    await generator.saveConfig(config, configPath);
    const loaded = generator.loadConfig(configPath);
    const scaffoldConfig = generator.toScaffoldConfig(loaded);
    const engine = new BrowserTemplateEngine(templateBundle) as BrowserTemplateEngineInstance;
    await engine.generateApplication({
      appName: scaffoldConfig.appName,
      basePackage: scaffoldConfig.basePackage,
      steps: scaffoldConfig.steps,
      aspects: scaffoldConfig.aspects,
      unionDefinitions: scaffoldConfig.unionDefinitions,
      transport: scaffoldConfig.transport,
      platform: scaffoldConfig.platform,
      runtimeLayout: scaffoldConfig.runtimeLayout,
      fileCallback
    });
    await fileCallback("config/pipeline.yaml", YAML.dump(loaded, { lineWidth: -1 }));
    if (compositionManifest) {
      await fileCallback("config/pipeline-composition.yaml", YAML.dump(compositionManifest, { lineWidth: -1 }));
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function resolvePackageRoot(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  let probeDir = currentDir;
  for (let index = 0; index < 4; index += 1) {
    const candidate = path.join(probeDir, "package.json");
    try {
      const packageJson = require(candidate) as { name?: string };
      if (packageJson.name === "@pipelineframework/tpf-mcp-bridge") {
        return probeDir;
      }
    } catch (_error) {
    }
    probeDir = path.dirname(probeDir);
  }
  throw new Error("Unable to locate the @pipelineframework/tpf-mcp-bridge package root.");
}

function resolveVendoredModulePath(fileName: string): string {
  const candidate = path.join(packageRoot, "template-generator-node", "src", fileName);
  try {
    return require.resolve(candidate);
  } catch (_error) {
    throw new Error(`Unable to locate vendored template-generator-node/src/${fileName} from the standalone bridge repo.`);
  }
}
