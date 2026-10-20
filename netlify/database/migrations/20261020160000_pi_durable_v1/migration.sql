-- Pi Durable's storage schema version 1 (@earendil-works/pi-durable 1.3.0, storage/sqlite/migrations.js), in Postgres,
-- with its tables prefixed pi_. Pi Durable runs its own migrations at open; src/storage/postgres.ts refuses the DDL
-- and finds pi_durable_schema already at the version below, so a Pi Durable upgrade that changes the schema fails at
-- start until its next version is added here as a new migration.
--
-- IDs, sequence numbers and the commit counter are BIGINT, read back as JavaScript numbers. Records are TEXT holding
-- JSON, as in SQLite: jsonb would reorder keys and refuse \u0000.

CREATE TABLE pi_durable_schema (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	version INTEGER NOT NULL CHECK (version >= 0)
);
INSERT INTO pi_durable_schema (singleton, version) VALUES (1, 1);

CREATE TABLE pi_durable_metadata (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	next_id TEXT NOT NULL,
	next_seq BIGINT NOT NULL
);
INSERT INTO pi_durable_metadata (singleton, next_id, next_seq) VALUES (1, '2', 1);

CREATE TABLE pi_record_ids (
	id BIGINT PRIMARY KEY,
	record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
);

CREATE TABLE pi_conversations (
	id BIGINT PRIMARY KEY,
	owner_conversation_id BIGINT,
	owner_task_id BIGINT,
	record TEXT NOT NULL
);
CREATE INDEX pi_conversations_by_owner_conversation ON pi_conversations (owner_conversation_id, id);
CREATE INDEX pi_conversations_by_owner_task ON pi_conversations (owner_task_id, id);

CREATE TABLE pi_entries (
	id BIGINT PRIMARY KEY,
	conversation_id BIGINT NOT NULL,
	head BIGINT,
	commit_seq BIGINT NOT NULL,
	record TEXT NOT NULL
);
CREATE INDEX pi_entries_by_conversation ON pi_entries (conversation_id, id DESC);
CREATE INDEX pi_entry_heads_by_conversation ON pi_entries (conversation_id, id DESC) WHERE head IS NOT NULL;

CREATE TABLE pi_tasks (
	id BIGINT PRIMARY KEY,
	conversation_id BIGINT NOT NULL,
	kind TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
	abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
	background INTEGER NOT NULL CHECK (background IN (0, 1)),
	record TEXT NOT NULL
);
CREATE INDEX pi_tasks_by_status ON pi_tasks (status, id);
CREATE INDEX pi_tasks_by_conversation ON pi_tasks (conversation_id, id);
CREATE INDEX pi_tasks_by_kind ON pi_tasks (kind, id);
CREATE INDEX pi_tasks_by_abort_requested ON pi_tasks (abort_requested, id);
CREATE INDEX pi_tasks_by_background ON pi_tasks (background, id);

CREATE TABLE pi_submissions (
	id BIGINT PRIMARY KEY,
	conversation_id BIGINT NOT NULL,
	request_id TEXT,
	status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
	record TEXT NOT NULL
);
CREATE INDEX pi_submissions_by_request ON pi_submissions (conversation_id, request_id);
CREATE INDEX pi_submissions_by_conversation ON pi_submissions (conversation_id, id);
CREATE INDEX pi_submissions_by_status ON pi_submissions (status, id);

CREATE TABLE pi_documents (
	id BIGINT PRIMARY KEY,
	kind TEXT NOT NULL,
	family INTEGER NOT NULL CHECK (family IN (0, 1)),
	key_value TEXT NOT NULL,
	scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
	owner_id BIGINT NOT NULL,
	created_at BIGINT NOT NULL,
	retired_at BIGINT,
	record TEXT NOT NULL
);
CREATE INDEX pi_documents_by_address ON pi_documents (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at);
CREATE INDEX pi_documents_by_scope ON pi_documents (scope_kind, owner_id, id);
CREATE INDEX pi_documents_by_scope_kind ON pi_documents (scope_kind, owner_id, kind, id);

CREATE TABLE pi_document_revisions (
	document_id BIGINT NOT NULL,
	seq BIGINT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
	version INTEGER NOT NULL,
	content TEXT NOT NULL,
	PRIMARY KEY (document_id, seq)
);
CREATE INDEX pi_document_revisions_by_kind ON pi_document_revisions (document_id, kind, seq DESC);

-- Which instance may write. Pi Durable allows one process per storage; see src/storage/lease.ts.
CREATE TABLE dreamwalker_lease (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	holder TEXT NOT NULL,
	generation TEXT NOT NULL,
	expires_at TIMESTAMPTZ NOT NULL
);
