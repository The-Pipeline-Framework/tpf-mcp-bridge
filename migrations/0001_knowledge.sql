PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS releases (
  version TEXT PRIMARY KEY,
  framework_commit TEXT NOT NULL,
  published_at TEXT NOT NULL,
  bundle_checksum TEXT NOT NULL,
  repowise_version TEXT NOT NULL,
  repowise_export_checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('STAGED', 'ACTIVE')),
  supported INTEGER NOT NULL DEFAULT 0 CHECK (supported IN (0, 1)),
  document_count INTEGER NOT NULL,
  source_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  version TEXT NOT NULL REFERENCES releases(version),
  id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('docs', 'api', 'examples', 'skill')),
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_checksum TEXT NOT NULL,
  PRIMARY KEY (version, id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  version UNINDEXED,
  id UNINDEXED,
  scope UNINDEXED,
  title,
  content,
  path,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS source_files (
  version TEXT NOT NULL REFERENCES releases(version),
  path TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_checksum TEXT NOT NULL,
  line_count INTEGER NOT NULL,
  PRIMARY KEY (version, path)
);

CREATE INDEX IF NOT EXISTS documents_version_scope ON documents(version, scope);
CREATE INDEX IF NOT EXISTS source_files_version ON source_files(version);
