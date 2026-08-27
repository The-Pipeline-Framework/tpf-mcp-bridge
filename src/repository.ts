import type {
  KnowledgePage,
  KnowledgeRepository,
  KnowledgeScope,
  KnowledgeVersionKind,
  ReleaseVersion,
  SearchHit,
  SearchRequest,
  SourceExcerpt,
} from "./types.js";

interface ReleaseRow {
  version: string;
  publication_kind: KnowledgeVersionKind;
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
        `SELECT a.public_version AS version, r.publication_kind, r.framework_commit,
                r.published_at, r.bundle_checksum, r.repowise_version
         FROM knowledge_aliases AS a
         JOIN releases AS r ON r.version = a.dataset_version
         WHERE r.status = 'ACTIVE' AND r.supported = 1
         ORDER BY r.published_at DESC, a.public_version DESC`,
      )
      .all<ReleaseRow>();
    return query.results.map((row) => ({
      version: row.version,
      kind: row.publication_kind,
      frameworkCommit: row.framework_commit,
      publishedAt: row.published_at,
      bundleChecksum: row.bundle_checksum,
      repowiseVersion: row.repowise_version,
    }));
  }

  async search(request: SearchRequest): Promise<SearchHit[]> {
    const scopeClause = request.scope === undefined ? "" : " AND f.scope = ?";
    const search = async (match: string): Promise<SearchRow[]> => {
      const statement = this.database.prepare(
        `SELECT f.id, f.scope, f.title, f.path,
                snippet(documents_fts, 4, '', '', ' … ', 18) AS snippet,
                r.framework_commit
         FROM documents_fts AS f
         JOIN knowledge_aliases AS a ON a.dataset_version = f.version
         JOIN releases AS r ON r.version = a.dataset_version
         WHERE a.public_version = ?${scopeClause}
           AND documents_fts MATCH ?
           AND r.status = 'ACTIVE' AND r.supported = 1
         ORDER BY CASE f.scope
                    WHEN 'skill' THEN 0
                    WHEN 'docs' THEN 1
                    WHEN 'examples' THEN 2
                    ELSE 3
                  END,
                  bm25(documents_fts, 0.0, 0.0, 0.0, 6.0, 3.0, 1.0)
         LIMIT ?`,
      );
      const bindings =
        request.scope === undefined
          ? [request.version, match, request.maxResults]
          : [request.version, request.scope, match, request.maxResults];
      return (await statement.bind(...bindings).all<SearchRow>()).results;
    };

    const exactMatch = toFtsQuery(request.query, "AND");
    const exact = await search(exactMatch);
    const fallbackMatch = toFtsQuery(request.query, "OR");
    const fallback =
      exact.length < request.maxResults && fallbackMatch !== exactMatch
        ? await search(fallbackMatch)
        : [];
    const rows = [...exact, ...fallback]
      .filter(
        (row, index, results) =>
          results.findIndex((candidate) => candidate.id === row.id) === index,
      )
      .slice(0, request.maxResults);
    return rows.map((row) => ({
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
         JOIN knowledge_aliases AS a ON a.dataset_version = d.version
         JOIN releases AS r ON r.version = a.dataset_version
         WHERE a.public_version = ? AND d.id IN (${placeholders})
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
         JOIN knowledge_aliases AS a ON a.dataset_version = s.version
         JOIN releases AS r ON r.version = a.dataset_version
         WHERE a.public_version = ? AND s.path = ?
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

export function toFtsQuery(
  query: string,
  operator: "AND" | "OR" = "AND",
): string {
  const tokens = query
    .normalize("NFKC")
    .match(/[\p{L}\p{N}_.-]+/gu)
    ?.slice(0, 32)
    .map((token) => `"${token.replaceAll('"', '""')}"`);
  if (tokens === undefined || tokens.length === 0) {
    return '""';
  }
  return tokens.join(` ${operator} `);
}

function githubCitation(commit: string, path: string): string {
  const sourcePath = path.split("::", 1)[0];
  return `${GITHUB_ROOT}/${encodeURIComponent(commit)}/${sourcePath.split("/").map(encodeURIComponent).join("/")}`;
}
