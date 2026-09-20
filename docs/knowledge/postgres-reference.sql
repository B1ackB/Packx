-- Migration reference only: NOT executed and NOT the active adapter.
-- Target to validate: PostgreSQL 17, pgvector 0.8.6, one approved 1024-dimensional model.
-- Run with a migration owner; the application must use a separate non-superuser,
-- non-BYPASSRLS role, and set scope from authenticated server identity per transaction.
BEGIN;
CREATE EXTENSION IF NOT EXISTS vector VERSION '0.8.6';
DO $$ BEGIN
	IF (SELECT extversion FROM pg_extension WHERE extname='vector') <> '0.8.6' THEN
		RAISE EXCEPTION 'pin and evaluate the installed pgvector version';
	END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS packx_knowledge;
CREATE TABLE packx_knowledge.document_versions (
	version_id text PRIMARY KEY,
	tenant_id text NOT NULL,
	workspace_id text NOT NULL,
	document_id text NOT NULL,
	content_hash text NOT NULL,
	visibility text NOT NULL CHECK (visibility IN ('workspace','public')),
	state text NOT NULL CHECK (state IN ('imported','parsed','indexed','needs_review','cancelled','withdrawn')),
	indexing_allowed boolean NOT NULL DEFAULT false,
	redistribution_allowed boolean NOT NULL DEFAULT false,
	permission_expires_at timestamptz,
	document_expires_at timestamptz,
	manifest jsonb NOT NULL,
	raw_ref text NOT NULL,
	UNIQUE (tenant_id,workspace_id,document_id,content_hash)
);
CREATE TABLE packx_knowledge.chunks (
	evidence_id text PRIMARY KEY,
	version_id text NOT NULL REFERENCES packx_knowledge.document_versions(version_id),
	block jsonb NOT NULL,
	lexical_terms text[] NOT NULL,
	-- Domain-controlled segmentation, not PostgreSQL's default language tokenizer.
	lexical tsvector NOT NULL,
	embedding vector(1024) NOT NULL,
	embedding_space text NOT NULL,
	index_version text NOT NULL
);
CREATE INDEX chunks_lexical ON packx_knowledge.chunks USING gin(lexical);
-- Exact cosine is the initial baseline. Add HNSW only after filtered recall and
-- permission regressions pass; approximate filtering can reduce recall.
ALTER TABLE packx_knowledge.document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE packx_knowledge.document_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE packx_knowledge.chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE packx_knowledge.chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY version_read ON packx_knowledge.document_versions FOR SELECT USING (
	(tenant_id = current_setting('packx.tenant_id',true)
		AND workspace_id = current_setting('packx.workspace_id',true)
		OR visibility='public' AND redistribution_allowed)
	AND state='indexed' AND indexing_allowed
	AND (permission_expires_at IS NULL OR permission_expires_at > now())
	AND (document_expires_at IS NULL OR document_expires_at > now())
);
CREATE POLICY chunk_read ON packx_knowledge.chunks FOR SELECT USING (
	EXISTS(SELECT 1 FROM packx_knowledge.document_versions d WHERE d.version_id=chunks.version_id)
);
-- No application write policy: ingestion requires a separately scoped reviewed migration.
-- Bound parameters must include embedding_space, model, region and applicable date.
-- Example query shape, not a function that bypasses RLS:
-- SELECT evidence_id,block,1-(embedding <=> $1::vector) AS similarity
-- FROM packx_knowledge.chunks c JOIN packx_knowledge.document_versions d USING(version_id)
-- WHERE c.embedding_space=$2 AND c.index_version=$3 AND d.manifest->>'model'=$4
-- ORDER BY c.embedding <=> $1::vector LIMIT $5;
-- Apply region/effective/publication-date predicates to this same candidate set.
-- ts_rank is NOT BM25. Fuse separately filtered ranked lists using RRF.
COMMIT;
-- Roll back in an isolated restore database only. Never drop original raw/selection
-- records or the live business database to undo a knowledge adapter experiment.
