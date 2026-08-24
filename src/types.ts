export const KNOWLEDGE_SCOPES = ["docs", "api", "examples", "skill"] as const;

export type KnowledgeScope = (typeof KNOWLEDGE_SCOPES)[number];

export interface ReleaseVersion {
  version: string;
  frameworkCommit: string;
  publishedAt: string;
  bundleChecksum: string;
  repowiseVersion: string;
}

export interface SearchRequest {
  version: string;
  query: string;
  scope?: KnowledgeScope;
  maxResults: number;
}

export interface SearchHit {
  id: string;
  scope: KnowledgeScope;
  title: string;
  path: string;
  snippet: string;
  citation: string;
}

export interface KnowledgePage {
  id: string;
  scope: KnowledgeScope;
  title: string;
  path: string;
  content: string;
  citation: string;
}

export interface SourceExcerpt {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  citation: string;
}

export interface KnowledgeRepository {
  listVersions(): Promise<ReleaseVersion[]>;
  search(request: SearchRequest): Promise<SearchHit[]>;
  getPages(version: string, ids: string[]): Promise<KnowledgePage[]>;
  getSource(
    version: string,
    path: string,
    startLine: number,
    endLine: number,
  ): Promise<SourceExcerpt | undefined>;
}

export class KnowledgeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_INPUT"
      | "UNSUPPORTED_VERSION"
      | "NOT_FOUND"
      | "INTERNAL",
  ) {
    super(message);
    this.name = "KnowledgeError";
  }
}
