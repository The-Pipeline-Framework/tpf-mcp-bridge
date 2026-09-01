import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { KnowledgeScope, KnowledgeVersionKind } from "./types.js";

const D1_STATEMENTS_PER_CHUNK = 50;

export interface RepowisePage {
  page_id?: string;
  title?: string;
  content?: string;
  target_path?: string;
}

export interface CompiledDocument {
  id: string;
  scope: KnowledgeScope;
  title: string;
  path: string;
  content: string;
  contentChecksum: string;
  objectKey: string;
}

export interface CompiledSource {
  path: string;
  content: string;
  contentChecksum: string;
  lineCount: number;
  objectKey: string;
}

export interface ReleaseManifest {
  schemaVersion: 2;
  kind: KnowledgeVersionKind;
  version: string;
  datasetVersion: string;
  frameworkCommit: string;
  publishedAt: string;
  bundleChecksum: string;
  repowiseVersion: string;
  repowiseExportChecksum: string;
  documentCount: number;
  sourceCount: number;
  scopes: Record<KnowledgeScope, number>;
}

export interface CompiledBundle {
  manifest: ReleaseManifest;
  documents: CompiledDocument[];
  sources: CompiledSource[];
}

const TEXT_EXTENSIONS = new Set([
  ".gradle",
  ".java",
  ".json",
  ".kt",
  ".md",
  ".properties",
  ".proto",
  ".toml",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const MAX_SOURCE_BYTES = 1_000_000;

export function classifyAuthorPath(input: string): KnowledgeScope | undefined {
  const filePath = normalizePath(input);
  if (filePath === undefined) return undefined;
  if (
    filePath === "README.md" ||
    /^(docs\/(?:design|develop|deploy|operate|value)\/)/.test(filePath)
  ) {
    return "docs";
  }
  if (filePath.startsWith(".agents/skills/tpf-authoring/")) {
    return "skill";
  }
  if (filePath.startsWith("examples/")) {
    return "examples";
  }
  if (
    /^framework\/(?:api|runtime-core|runtime|connectors|plugins)\/.*\/src\/main\//.test(
      filePath,
    ) ||
    /^framework\/(?:api|runtime-core|runtime)\/src\/main\//.test(filePath) ||
    filePath.startsWith(
      "framework/deployment/src/main/resources/META-INF/pipeline/",
    )
  ) {
    return "api";
  }
  return undefined;
}

export function compileBundle(options: {
  frameworkDir: string;
  version: string;
  frameworkCommit: string;
  publishedAt: string;
  repowiseVersion: string;
  repowiseExportBytes: Uint8Array;
  kind?: KnowledgeVersionKind;
}): CompiledBundle {
  const kind = options.kind ?? "RELEASE";
  const parsed = JSON.parse(
    new TextDecoder().decode(options.repowiseExportBytes),
  ) as { pages?: RepowisePage[] };
  if (!Array.isArray(parsed.pages)) {
    throw new Error("Repowise full JSON export must contain a pages array");
  }
  const sourceSeeds = readApprovedSources(options.frameworkDir).sort(
    (left, right) => compare(left.path, right.path),
  );
  const documentSeeds = [
    ...parsed.pages
      .map((page) => normalizePage(page, options.version))
      .filter(
        (page): page is Omit<CompiledDocument, "objectKey"> =>
          page !== undefined,
      ),
    ...sourceSeeds
      .map((source) => normalizeAuthorSource(source, options.version))
      .filter(
        (document): document is Omit<CompiledDocument, "objectKey"> =>
          document !== undefined,
      ),
  ].sort(
    (left, right) =>
      compare(left.path, right.path) ||
      compare(left.title, right.title) ||
      compare(left.id, right.id),
  );
  const duplicateIds = documentSeeds
    .filter(
      (document, index, documents) =>
        documents.findIndex((candidate) => candidate.id === document.id) !==
        index,
    )
    .map((document) => document.id);
  if (duplicateIds.length > 0) {
    throw new Error(
      `Repowise export contains duplicate document IDs: ${[...new Set(duplicateIds)].join(", ")}`,
    );
  }
  const repowiseExportChecksum = sha256(options.repowiseExportBytes);
  const bundleChecksum = sha256(
    JSON.stringify({
      schemaVersion: 2,
      kind,
      version: options.version,
      frameworkCommit: options.frameworkCommit,
      repowiseExportChecksum,
      documents: documentSeeds.map(({ content, ...document }) => ({
        ...document,
        contentChecksum: sha256(content),
      })),
      sources: sourceSeeds.map(({ content, ...source }) => ({
        ...source,
        contentChecksum: sha256(content),
      })),
    }),
  );
  const prefix = objectPrefix(
    kind,
    options.version,
    options.frameworkCommit,
    bundleChecksum,
  );
  const datasetVersion =
    kind === "RELEASE"
      ? options.version
      : `${options.version}@${options.frameworkCommit.slice(0, 12)}.${bundleChecksum.slice(0, 12)}`;
  const documents = documentSeeds.map((document) => ({
    ...document,
    objectKey: `${prefix}/pages/${document.id}.json`,
  }));
  const sources = sourceSeeds.map((source) => ({
    ...source,
    objectKey: `${prefix}/source/${source.path}`,
  }));
  const scopes = Object.fromEntries(
    (["docs", "api", "examples", "skill"] as KnowledgeScope[]).map((scope) => [
      scope,
      documents.filter((document) => document.scope === scope).length,
    ]),
  ) as Record<KnowledgeScope, number>;
  return {
    manifest: {
      schemaVersion: 2,
      kind,
      version: options.version,
      datasetVersion,
      frameworkCommit: options.frameworkCommit,
      publishedAt: options.publishedAt,
      bundleChecksum,
      repowiseVersion: options.repowiseVersion,
      repowiseExportChecksum,
      documentCount: documents.length,
      sourceCount: sources.length,
      scopes,
    },
    documents,
    sources,
  };
}

export function writeBundle(bundle: CompiledBundle, outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });
  const objectsDir = path.join(outputDir, "objects");
  const uploads: Array<{ key: string; file: string; contentType: string }> = [];
  for (const document of bundle.documents) {
    const file = path.join(objectsDir, "pages", `${document.id}.json`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({
        id: document.id,
        scope: document.scope,
        title: document.title,
        path: document.path,
        content: document.content,
      })}\n`,
    );
    uploads.push({
      key: document.objectKey,
      file,
      contentType: "application/json",
    });
  }
  for (const source of bundle.sources) {
    const file = path.join(objectsDir, "source", source.path);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source.content);
    uploads.push({
      key: source.objectKey,
      file,
      contentType: "text/plain; charset=utf-8",
    });
  }
  const manifestFile = path.join(outputDir, "manifest.json");
  writeFileSync(
    manifestFile,
    `${JSON.stringify(bundle.manifest, undefined, 2)}\n`,
  );
  uploads.push({
    key: `${objectPrefix(bundle.manifest.kind, bundle.manifest.version, bundle.manifest.frameworkCommit, bundle.manifest.bundleChecksum)}/manifest.json`,
    file: manifestFile,
    contentType: "application/json",
  });
  writeFileSync(
    path.join(outputDir, "uploads.json"),
    `${JSON.stringify(uploads, undefined, 2)}\n`,
  );
  const stageStatementGroups = renderStageStatementGroups(bundle);
  writeFileSync(
    path.join(outputDir, "stage.sql"),
    renderSql(stageStatementGroups.flat()),
  );
  const sqlDir = path.join(outputDir, "sql");
  mkdirSync(sqlDir, { recursive: true });
  const stageChunks = chunkStatementGroups(stageStatementGroups).map(
    (statements, index) => {
      const relative = path.join(
        "sql",
        `stage-${String(index + 1).padStart(4, "0")}.sql`,
      );
      writeFileSync(path.join(outputDir, relative), renderSql(statements));
      return relative;
    },
  );
  writeFileSync(
    path.join(outputDir, "stage-chunks.json"),
    `${JSON.stringify(stageChunks, undefined, 2)}\n`,
  );
  writeFileSync(
    path.join(outputDir, "activate.sql"),
    renderActivationSql(
      bundle.manifest.version,
      bundle.manifest.datasetVersion,
    ),
  );
}

export function supportedMinorLines(versions: string[], keep = 3): Set<string> {
  const lines = [
    ...new Set(
      versions
        .map(minorLine)
        .filter((line): line is string => line !== undefined),
    ),
  ]
    .sort(compareVersions)
    .reverse()
    .slice(0, keep);
  return new Set(lines);
}

export function validateImmutableRelease(
  existingChecksums: string[],
  requestedChecksum: string,
): "CREATE" | "EXISTS" {
  if (existingChecksums.length === 0) return "CREATE";
  if (existingChecksums.every((checksum) => checksum === requestedChecksum))
    return "EXISTS";
  throw new Error("Release already exists with a different immutable checksum");
}

export function verifyFrameworkRelease(
  frameworkDir: string,
  version: string,
): {
  commit: string;
  publishedAt: string;
} {
  const status = git(frameworkDir, ["status", "--porcelain"]);
  if (status.trim().length > 0) {
    throw new Error(
      `Framework checkout must be clean before publishing ${version}`,
    );
  }
  let tag = "";
  try {
    tag = git(frameworkDir, [
      "describe",
      "--tags",
      "--exact-match",
      "HEAD",
    ]).trim();
  } catch {
    tag = "";
  }
  if (tag !== `v${version}`) {
    throw new Error(
      `Framework HEAD must be exact tag v${version}; found '${tag || "no tag"}'`,
    );
  }
  return {
    commit: git(frameworkDir, ["rev-parse", "HEAD"]).trim(),
    publishedAt: git(frameworkDir, [
      "show",
      "-s",
      "--format=%cI",
      "HEAD",
    ]).trim(),
  };
}

export function verifyFrameworkSnapshot(
  frameworkDir: string,
  version: string,
): {
  commit: string;
  publishedAt: string;
} {
  const status = git(frameworkDir, ["status", "--porcelain"]);
  if (status.trim().length > 0) {
    throw new Error(
      `Framework checkout must be clean before publishing ${version}`,
    );
  }
  const pom = readFileSync(path.join(frameworkDir, "pom.xml"), "utf8");
  const projectVersion = /<project[\s\S]*?<version>([^<]+)<\/version>/.exec(
    pom,
  )?.[1];
  if (projectVersion !== version) {
    throw new Error(
      `Framework root project version must be ${version}; found '${projectVersion ?? "none"}'`,
    );
  }
  return {
    commit: git(frameworkDir, ["rev-parse", "HEAD"]).trim(),
    publishedAt: git(frameworkDir, [
      "show",
      "-s",
      "--format=%cI",
      "HEAD",
    ]).trim(),
  };
}

function normalizePage(
  page: RepowisePage,
  version: string,
): Omit<CompiledDocument, "objectKey"> | undefined {
  const targetPath =
    typeof page.target_path === "string" ? normalizePath(page.target_path) : "";
  if (targetPath === undefined) return undefined;
  const scope = classifyAuthorPath(targetPath);
  const title = typeof page.title === "string" ? page.title.trim() : "";
  const content = typeof page.content === "string" ? page.content.trim() : "";
  if (scope === undefined || title.length === 0 || content.length === 0) {
    return undefined;
  }
  const seed = `${version}\0${targetPath}\0${page.page_id ?? title}`;
  return {
    id: sha256(seed).slice(0, 24),
    scope,
    title,
    path: targetPath,
    content,
    contentChecksum: sha256(content),
  };
}

function normalizeAuthorSource(
  source: Omit<CompiledSource, "objectKey">,
  version: string,
): Omit<CompiledDocument, "objectKey"> | undefined {
  const scope = classifyAuthorPath(source.path);
  if (
    (scope !== "docs" && scope !== "skill") ||
    path.extname(source.path).toLowerCase() !== ".md"
  ) {
    return undefined;
  }
  const content = source.content.trim();
  if (content.length === 0) return undefined;
  const title = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? source.path;
  return {
    id: sha256(`${version}\0${source.path}\0author-source`).slice(0, 24),
    scope,
    title,
    path: source.path,
    content,
    contentChecksum: sha256(content),
  };
}

function readApprovedSources(
  frameworkDir: string,
): Array<Omit<CompiledSource, "objectKey">> {
  const paths = git(frameworkDir, ["ls-tree", "-r", "--name-only", "HEAD"])
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(
      (entry) =>
        entry.length > 0 &&
        classifyAuthorPath(entry) !== undefined &&
        TEXT_EXTENSIONS.has(path.extname(entry).toLowerCase()),
    );
  return paths.flatMap((filePath) => {
    const content = readFileSync(path.join(frameworkDir, filePath));
    if (content.length > MAX_SOURCE_BYTES || content.includes(0)) {
      return [];
    }
    const text = new TextDecoder().decode(content);
    return [
      {
        path: filePath,
        content: text,
        contentChecksum: sha256(text),
        lineCount: text.split(/\r?\n/).length,
      },
    ];
  });
}

function renderStageStatementGroups(bundle: CompiledBundle): string[][] {
  const manifest = bundle.manifest;
  const groups: string[][] = [
    [
      `INSERT OR IGNORE INTO releases (version, publication_kind, framework_commit, published_at, bundle_checksum, repowise_version, repowise_export_checksum, status, supported, document_count, source_count) VALUES (${sqlLiteral(manifest.datasetVersion)}, ${sqlLiteral(manifest.kind)}, ${sqlLiteral(manifest.frameworkCommit)}, ${sqlLiteral(manifest.publishedAt)}, ${sqlLiteral(manifest.bundleChecksum)}, ${sqlLiteral(manifest.repowiseVersion)}, ${sqlLiteral(manifest.repowiseExportChecksum)}, 'STAGED', 0, ${manifest.documentCount}, ${manifest.sourceCount});`,
      `DELETE FROM documents_fts WHERE version = ${sqlLiteral(manifest.datasetVersion)};`,
    ],
  ];
  for (const document of bundle.documents) {
    groups.push([
      `INSERT OR REPLACE INTO documents (version, id, scope, title, path, object_key, content_checksum) VALUES (${sqlLiteral(manifest.datasetVersion)}, ${sqlLiteral(document.id)}, ${sqlLiteral(document.scope)}, ${sqlLiteral(document.title)}, ${sqlLiteral(document.path)}, ${sqlLiteral(document.objectKey)}, ${sqlLiteral(document.contentChecksum)});`,
      `INSERT INTO documents_fts (version, id, scope, title, content, path) VALUES (${sqlLiteral(manifest.datasetVersion)}, ${sqlLiteral(document.id)}, ${sqlLiteral(document.scope)}, ${sqlLiteral(document.title)}, ${sqlLiteral(document.content)}, ${sqlLiteral(document.path)});`,
    ]);
  }
  for (const source of bundle.sources) {
    groups.push([
      `INSERT OR REPLACE INTO source_files (version, path, object_key, content_checksum, line_count) VALUES (${sqlLiteral(manifest.datasetVersion)}, ${sqlLiteral(source.path)}, ${sqlLiteral(source.objectKey)}, ${sqlLiteral(source.contentChecksum)}, ${source.lineCount});`,
    ]);
  }
  return groups;
}

function chunkStatementGroups(groups: string[][]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const group of groups) {
    if (
      current.length > 0 &&
      current.length + group.length > D1_STATEMENTS_PER_CHUNK
    ) {
      chunks.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function renderSql(statements: string[]): string {
  return `${statements.join("\n")}\n`;
}

function objectPrefix(
  kind: KnowledgeVersionKind,
  version: string,
  frameworkCommit: string,
  bundleChecksum: string,
): string {
  return kind === "RELEASE"
    ? `releases/${version}/${bundleChecksum}`
    : `snapshots/${version}/${frameworkCommit}/${bundleChecksum}`;
}

function renderActivationSql(
  publicVersion: string,
  datasetVersion: string,
): string {
  return `UPDATE releases SET status = 'ACTIVE', supported = 1 WHERE version = ${sqlLiteral(datasetVersion)} AND status = 'STAGED';\nINSERT INTO knowledge_aliases (public_version, dataset_version) VALUES (${sqlLiteral(publicVersion)}, ${sqlLiteral(datasetVersion)}) ON CONFLICT(public_version) DO UPDATE SET dataset_version = excluded.dataset_version;\n`;
}

function minorLine(version: string): string | undefined {
  const match = /^(\d+)\.(\d+)\.\d+(?:[-+].*)?$/.exec(version);
  return match === null ? undefined : `${match[1]}.${match[2]}`;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  return (
    leftParts[0] - rightParts[0] ||
    leftParts[1] - rightParts[1] ||
    (leftParts[2] ?? 0) - (rightParts[2] ?? 0)
  );
}

export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePath(value: string): string | undefined {
  const portable = value.replaceAll("\\", "/");
  if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable)) {
    return undefined;
  }
  const normalized = path.posix.normalize(portable).replace(/^\.\//, "");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return undefined;
  }
  return normalized;
}

function compare(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function git(directory: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
