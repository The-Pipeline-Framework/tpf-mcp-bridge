ALTER TABLE releases
ADD COLUMN publication_kind TEXT NOT NULL DEFAULT 'RELEASE'
CHECK (publication_kind IN ('RELEASE', 'SNAPSHOT'));

CREATE INDEX IF NOT EXISTS releases_kind_status
ON releases(publication_kind, status, supported);

CREATE TABLE IF NOT EXISTS knowledge_aliases (
  public_version TEXT PRIMARY KEY,
  dataset_version TEXT NOT NULL REFERENCES releases(version)
);

INSERT OR IGNORE INTO knowledge_aliases (public_version, dataset_version)
SELECT version, version FROM releases WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS knowledge_aliases_dataset
ON knowledge_aliases(dataset_version);
