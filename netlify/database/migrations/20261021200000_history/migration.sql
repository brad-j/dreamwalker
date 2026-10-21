-- Past conversations, searchable (src/history.ts): the owner's messages and the agents' answers, from the
-- conversations that are an agent's own (its home and its jobs' runs, not its workers'), with English full-text search.
-- It's an index of Pi Durable's entries, which keep everything; rows can be rebuilt from them.
CREATE TABLE dreamwalker_history (
	entry_id BIGINT PRIMARY KEY,
	conversation_id BIGINT NOT NULL,
	agent TEXT NOT NULL,
	who TEXT NOT NULL CHECK (who IN ('owner', 'agent')),
	place TEXT NOT NULL,
	at TIMESTAMPTZ NOT NULL,
	text TEXT NOT NULL,
	words TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);
CREATE INDEX dreamwalker_history_words ON dreamwalker_history USING GIN (words);
CREATE INDEX dreamwalker_history_by_agent ON dreamwalker_history (agent, at DESC);
CREATE INDEX dreamwalker_history_by_conversation ON dreamwalker_history (conversation_id, entry_id);
