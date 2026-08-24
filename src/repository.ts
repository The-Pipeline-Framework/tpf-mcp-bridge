import type {
  KnowledgePage,
  KnowledgeRepository,
  KnowledgeScope,
  ReleaseVersion,
  SearchHit,
  SearchRequest,
  SourceExcerpt,
} from "./types.js";

interface ReleaseRow {
  version: string;
  framework_commit: string;
  published_at: string;
  bundle_checksum: string;
  repowise_version: string;
}

interface SearchRow {
  id: string;
  scope: KnowledgeScope;
  title: string;
  path: string;
  snippet: string;
  framework_commit: string;
}

interface DocumentRow {
  id: string;
  scope: KnowledgeScope;
  title: string;
  path: string;
  object_key: string;
  framework_commit: string;
}

interface SourceRow {
  path: string;
  object_key: string;
  line_count: number;
  framework_commit: string;
}

interface StoredPage {
  id: string;
  scope: KnowledgeScope;
  title: string;
  path: string;
  content: string;
}

const GITHUB_ROOT =
  "https://github.com/The-Pipeline-Framework/pipelineframework/blob";

export class D1R2KnowledgeRepository implements KnowledgeRepository {
  constructor(
    private readonly database: D1Database,
    private readonly objects: R2Bucket,
  ) {}

  async listVersions(): Promise<ReleaseVersion[]> {
    const query = await this.database
      .prepare(
        `SELECT version, framework_commit, published_at, bundle_checksum, repowise_version
         FROM releases
         WHERE status = 'ACTIVE' AND supported = 1
         ORDER BY published_at DESC, version DESC`,
      )
      .all<ReleaseRow>();
    return query.results.map((row) => ({
      version: row.version,
      frameworkCommit: row.framework_commit,
      publishedAt: row.published_at,
      bundleChecksum: row.bundle_checksum,
      repowiseVersion: row.repowise_version,
    }));
  }

  async search(request: SearchRequest): Promise<SearchHit[]> {
    const match = toFtsQuery(request.query);
    const scopeClause = request.scope === undefined ? "" : " AND f.scope = ?";
    const statement = this.database.prepare(
      `SELECT f.id, f.scope, f.title, f.path,
              snippet(documents_fts, 4, '', '', ' … ', 18) AS snippet,
              r.framework_commit
       FROM documents_fts AS f
       JOIN releases AS r ON r.version = f.version
       WHERE f.version = ?${scopeClause}
         AND documents_fts MATCH ?
         AND r.status = 'ACTIVE' AND r.supported = 1
       ORDER BY bm25(documents_fts, 0.0, 0.0, 0.0, 6.0, 3.0, 1.0)
       LIMIT ?`,
    );
    const bindings =
      request.scope === undefined
        ? [request.version, match, request.maxResults]
        : [request.version, request.scope, match, request.maxResults];
    const query = await statement.bind(...bindings).all<SearchRow>();
    return query.results.map((row) => ({
      id: row.id,
      scope: row.scope,
      title: row.title,
      path: row.path,
      snippet: row.snippet,
      citation: githubCitation(row.framework_commit, row.path),
    }));
  }

  async getPages(version: string, ids: string[]): Promise<KnowledgePage[]> {
    if (ids.length === 0) {
      return [];
    }
    const placeholders = ids.map(() => "?").join(", ");
    const query = await this.database
      .prepare(
        `SELECT d.id, d.scope, d.title, d.path, d.object_key, r.framework_commit
         FROM documents AS d
         JOIN releases AS r ON r.version = d.version
         WHERE d.version = ? AND d.id IN (${placeholders})
           AND r.status = 'ACTIVE' AND r.supported = 1`,
      )
      .bind(version, ...ids)
      .all<DocumentRow>();
    const byId = new Map(query.results.map((row) => [row.id, row]));
    const rows = ids
      .map((id) => byId.get(id))
      .filter((row): row is DocumentRow => row !== undefined);
    return Promise.all(
      rows.map(async (row) => {
        const object = await this.objects.get(row.object_key);
        if (object === null) {
          throw new Error(`Knowledge object '${row.object_key}' is missing`);
        }
        const stored = JSON.parse(await object.text()) as StoredPage;
        return {
          id: stored.id,
          scope: stored.scope,
          title: stored.title,
          path: stored.path,
          content: stored.content,
          citation: githubCitation(row.framework_commit, stored.path),
        };
      }),
    );
  }

  async getSource(
    version: string,
    path: string,
    startLine: number,
    endLine: number,
  ): Promise<SourceExcerpt | undefined> {
    const row = await this.database
      .prepare(
        `SELECT s.path, s.object_key, s.line_count, r.framework_commit
         FROM source_files AS s
         JOIN releases AS r ON r.version = s.version
         WHERE s.version = ? AND s.path = ?
           AND r.status = 'ACTIVE' AND r.supported = 1`,
      )
      .bind(version, path)
      .first<SourceRow>();
    if (row === null) {
      return undefined;
    }
    const object = await this.objects.get(row.object_key);
    if (object === null) {
      throw new Error(`Source object '${row.object_key}' is missing`);
    }
    if (startLine > row.line_count) {
      return undefined;
    }
    const lines = (await object.text()).split(/\r?\n/);
    const actualStart = Math.min(startLine, Math.max(row.line_count, 1));
    const actualEnd = Math.min(endLine, row.line_count);
    return {
      path,
      startLine: actualStart,
      endLine: actualEnd,
      content: lines.slice(actualStart - 1, actualEnd).join("\n"),
      citation: `${githubCitation(row.framework_commit, path)}#L${actualStart}-L${actualEnd}`,
    };
  }
}

export function toFtsQuery(query: string): string {
  const tokens = query
    .normalize("NFKC")
    .match(/[\p{L}\p{N}_.-]+/gu)
    ?.slice(0, 32)
    .map((token) => `"${token.replaceAll('"', '""')}"`);
  if (tokens === undefined || tokens.length === 0) {
    return '""';
  }
  return tokens.join(" OR ");
}

function githubCitation(commit: string, path: string): string {
  return `${GITHUB_ROOT}/${encodeURIComponent(commit)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}
