import type {
  KnowledgePage,
  KnowledgeRepository,
  KnowledgeScope,
  ReleaseVersion,
  SearchHit,
  SourceExcerpt,
} from "./types.js";
import { KnowledgeError } from "./types.js";

const MAX_QUERY_LENGTH = 500;
const MAX_RESULTS = 20;
const MAX_CONTEXT_IDS = 5;
const MAX_CONTEXT_CHARACTERS = 50_000;
const MAX_SOURCE_LINES = 200;
const TRUNCATION_MARKER = "\n\n[content truncated by MCP response limit]";
const SOURCE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

export class KnowledgeService {
  constructor(private readonly repository: KnowledgeRepository) {}

  listVersions(): Promise<ReleaseVersion[]> {
    return this.repository.listVersions();
  }

  async search(
    version: string,
    query: string,
    scope: KnowledgeScope | undefined,
    maxResults = 8,
  ): Promise<SearchHit[]> {
    await this.requireVersion(version);
    const normalized = query.trim();
    if (normalized.length === 0 || normalized.length > MAX_QUERY_LENGTH) {
      throw new KnowledgeError(
        `query must contain 1-${MAX_QUERY_LENGTH} characters`,
        "INVALID_INPUT",
      );
    }
    if (
      !Number.isInteger(maxResults) ||
      maxResults < 1 ||
      maxResults > MAX_RESULTS
    ) {
      throw new KnowledgeError(
        `maxResults must be an integer from 1 to ${MAX_RESULTS}`,
        "INVALID_INPUT",
      );
    }
    return this.repository.search({
      version,
      query: normalized,
      scope,
      maxResults,
    });
  }

  async context(version: string, ids: string[]): Promise<KnowledgePage[]> {
    await this.requireVersion(version);
    const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0 || uniqueIds.length > MAX_CONTEXT_IDS) {
      throw new KnowledgeError(
        `ids must contain 1-${MAX_CONTEXT_IDS} distinct result IDs`,
        "INVALID_INPUT",
      );
    }
    const pages = await this.repository.getPages(version, uniqueIds);
    if (pages.length !== uniqueIds.length) {
      const found = new Set(pages.map((page) => page.id));
      const missing = uniqueIds.filter((id) => !found.has(id));
      throw new KnowledgeError(
        `Knowledge result not found for ${version}: ${missing.join(", ")}`,
        "NOT_FOUND",
      );
    }
    return truncatePages(pages);
  }

  async source(
    version: string,
    path: string,
    startLine = 1,
    endLine?: number,
  ): Promise<SourceExcerpt> {
    await this.requireVersion(version);
    const normalizedPath = path.trim().replaceAll("\\", "/");
    if (!SOURCE_PATH.test(normalizedPath)) {
      throw new KnowledgeError(
        "path must be a relative approved repository path",
        "INVALID_INPUT",
      );
    }
    if (!Number.isInteger(startLine) || startLine < 1) {
      throw new KnowledgeError(
        "startLine must be a positive integer",
        "INVALID_INPUT",
      );
    }
    const requestedEnd = endLine ?? startLine + MAX_SOURCE_LINES - 1;
    if (!Number.isInteger(requestedEnd) || requestedEnd < startLine) {
      throw new KnowledgeError(
        "endLine must be an integer greater than or equal to startLine",
        "INVALID_INPUT",
      );
    }
    if (requestedEnd - startLine + 1 > MAX_SOURCE_LINES) {
      throw new KnowledgeError(
        `A source request may contain at most ${MAX_SOURCE_LINES} lines`,
        "INVALID_INPUT",
      );
    }
    const excerpt = await this.repository.getSource(
      version,
      normalizedPath,
      startLine,
      requestedEnd,
    );
    if (excerpt === undefined) {
      throw new KnowledgeError(
        `Approved source path not found for ${version}: ${normalizedPath}`,
        "NOT_FOUND",
      );
    }
    return excerpt;
  }

  private async requireVersion(version: string): Promise<void> {
    const versions = await this.repository.listVersions();
    if (versions.some((candidate) => candidate.version === version)) {
      return;
    }
    const available =
      versions.map((candidate) => candidate.version).join(", ") || "none";
    throw new KnowledgeError(
      `Unsupported TPF version '${version}'. Available exact versions: ${available}`,
      "UNSUPPORTED_VERSION",
    );
  }
}

function truncatePages(pages: KnowledgePage[]): KnowledgePage[] {
  let remaining = MAX_CONTEXT_CHARACTERS;
  return pages.map((page, index) => {
    const reservedForLater =
      (pages.length - index - 1) * TRUNCATION_MARKER.length;
    const budget = Math.max(remaining - reservedForLater, 0);
    const content =
      page.content.length <= budget
        ? page.content
        : `${page.content.slice(0, Math.max(budget - TRUNCATION_MARKER.length, 0))}${TRUNCATION_MARKER.slice(0, budget)}`;
    remaining = Math.max(remaining - content.length, 0);
    return { ...page, content };
  });
}
