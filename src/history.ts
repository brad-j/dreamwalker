// Past conversations, from gaidin: search_history finds the owner's messages and an agent's answers in the agent's
// own past conversations (its home and its jobs' runs), and read_history shows the messages around one. Pi Durable keeps
// every entry, but can't search them, so dreamwalker keeps an index in Netlify Database (`dreamwalker_history`), with
// Postgres's English full-text search: every word has to appear, and word endings don't matter.
//
// The index follows Pi's commits as they happen, and each agent's home is caught up when the host opens, which also
// fills it from history written before it. A worker's conversation isn't indexed: its task isn't the owner's words, and
// what it found reaches its agent's answer. Tool results aren't indexed either, so a fact only a page or a command
// printed is found if an agent repeated it. Past answers can repeat outside text, so what these tools return is outside
// text, and each agent finds only its own.
import { Type } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { AssistantEntry, defineExtension, defineTool, type EntryRecord, type Harness, ROOT_CONVERSATION_ID, UserEntry } from "@earendil-works/pi-durable";
import { assistantText } from "./answers.ts";
import { guard } from "./guards.ts";
import { conversationId, entryId } from "./ids.ts";
import { OwnerMarks, OwnerMessage } from "./outside.ts";
import { object } from "./parse.ts";
import { AgentOf, agentOf, Agents, DEFAULT_AGENT } from "./roster.ts";
import { PostgresDatabase } from "./storage/postgres.ts";

/** One indexed message: the owner's or an agent's, in a home conversation or a job's run. */
export type HistoryRow = { entryId: number; conversationId: number; agent: string; who: "owner" | "agent"; place: "conversation" | "job run"; at: number; text: string };
export type HistoryHit = HistoryRow & { snippet: string };

export type HistoryStore = {
	add(rows: readonly HistoryRow[]): Promise<void>;
	/** The newest `limit` messages of `agent` with every word of `query`, newest first, by Pi's creation order. */
	search(agent: string, query: string, limit: number): Promise<HistoryHit[]>;
	/** Message `entryId` of `agent` and up to `around` either side of it in its conversation, oldest first. */
	around(agent: string, entryId: number, around: number): Promise<HistoryRow[]>;
	/** The newest entry indexed from conversation `id`, or 0. */
	newest(id: number): Promise<number>;
	close(): Promise<void>;
};

type Stored = { entry_id: number; conversation_id: number; agent: string; who: "owner" | "agent"; place: "conversation" | "job run"; at: Date; text: string; snippet?: string };
const rowOf = (r: Stored): HistoryRow => ({ entryId: r.entry_id, conversationId: r.conversation_id, agent: r.agent, who: r.who, place: r.place, at: r.at.getTime(), text: r.text });

/** The index in Netlify Database. Its rows can be rebuilt from Pi's entries, so it takes no lease. */
export function postgresHistory(connectionString: () => string): HistoryStore {
	const db = new PostgresDatabase({ connectionString });
	return {
		async add(rows) {
			for (const r of rows) {
				await db.run(
					"INSERT INTO dreamwalker_history (entry_id, conversation_id, agent, who, place, at, text) VALUES (?, ?, ?, ?, ?, to_timestamp(? / 1000.0), ?) ON CONFLICT (entry_id) DO NOTHING",
					r.entryId,
					r.conversationId,
					r.agent,
					r.who,
					r.place,
					r.at,
					r.text,
				);
			}
		},
		async search(agent, query, limit) {
			const rows = await db.all<Stored>(
				`SELECT entry_id, conversation_id, agent, who, place, at, text, ts_headline('english', text, plainto_tsquery('english', ?), 'MaxWords=30, MinWords=10, StartSel=**, StopSel=**') AS snippet
				FROM dreamwalker_history WHERE agent = ? AND words @@ plainto_tsquery('english', ?) ORDER BY entry_id DESC LIMIT ?`,
				query,
				agent,
				query,
				limit,
			);
			return rows.map((r) => ({ ...rowOf(r), snippet: r.snippet ?? r.text }));
		},
		async around(agent, entryId, around) {
			const found = await db.get<{ conversation_id: number }>("SELECT conversation_id FROM dreamwalker_history WHERE entry_id = ? AND agent = ?", entryId, agent);
			if (found === undefined) return [];
			const rows = await db.all<Stored>(
				`(SELECT * FROM dreamwalker_history WHERE conversation_id = ? AND entry_id <= ? ORDER BY entry_id DESC LIMIT ?)
				UNION (SELECT * FROM dreamwalker_history WHERE conversation_id = ? AND entry_id > ? ORDER BY entry_id LIMIT ?) ORDER BY entry_id`,
				found.conversation_id,
				entryId,
				around + 1,
				found.conversation_id,
				entryId,
				around,
			);
			return rows.map(rowOf);
		},
		async newest(id) {
			return (await db.get<{ newest: number | null }>("SELECT max(entry_id) AS newest FROM dreamwalker_history WHERE conversation_id = ?", id))?.newest ?? 0;
		},
		close: () => db.close(),
	};
}

/** Whose words entry `entry` of conversation `id` is, and its text; undefined for one that isn't indexed. */
function wordsOf(entry: EntryRecord, id: number, since: number): { who: "owner" | "agent"; text: string } | undefined {
	const message = entry.model?.[0];
	if (OwnerMessage.is(entry) || (UserEntry.is(entry) && id === ROOT_CONVERSATION_ID && Number(entry.id) <= since)) {
		if (message?.role !== "user") return undefined;
		const content = message.content;
		const text = (Array.isArray(content) ? content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("") : String(content)).replace(/^\[[^\]]*\] /, "");
		return text.trim() === "" ? undefined : { who: "owner", text };
	}
	if (AssistantEntry.is(entry)) {
		const text = assistantText(entry);
		return text === undefined || text.trim() === "" ? undefined : { who: "agent", text };
	}
	return undefined;
}

const MAX_HITS = 10;
const AROUND = 3;

/** The home conversations: dreamwalker's root and each agent's. */
async function homesOf(harness: Harness): Promise<Set<number>> {
	return new Set([ROOT_CONVERSATION_ID, ...((await harness.snapshot(Agents, background))?.items ?? []).map((a) => a.conversationId)]);
}

export function createHistory(store: HistoryStore | undefined, owner: string) {
	/** The rows for `entries` of conversation `id`, or none when it's a worker's. */
	async function rowsFor(harness: Harness, id: number, entries: readonly EntryRecord[]): Promise<HistoryRow[]> {
		const of = await harness.snapshot(AgentOf, conversationId(id), background);
		if (of?.worker === true) return [];
		const homes = await homesOf(harness);
		const since = (await harness.snapshot(OwnerMarks, background))?.since ?? -1;
		const agent = of?.agent ?? DEFAULT_AGENT;
		return entries.flatMap((entry) => {
			const words = wordsOf(entry, id, since);
			if (words === undefined) return [];
			const at = entry.model?.[0]?.timestamp ?? Date.now();
			return [{ entryId: Number(entry.id), conversationId: id, agent, ...words, place: homes.has(id) ? ("conversation" as const) : ("job run" as const), at, text: words.text.slice(0, 20_000) }];
		});
	}

	/**
	 * Follows `harness`'s commits into the index from now on, and returns once each home conversation is caught up.
	 * Indexing runs after each commit, off the commit's path; a failure is logged and the message is left out.
	 */
	function attach(harness: Harness): Promise<void> {
		if (store === undefined) return Promise.resolve();
		let queue = Promise.resolve();
		// What's still queued when the host closes is left for the next catch-up.
		let closing = false;
		harness.subscribeClose(() => {
			closing = true;
		});
		harness.subscribeCommits((publication) => {
			const entries = publication.changes.flatMap((c) => (c.type === "entry" ? [c.value] : []));
			if (entries.length === 0) return;
			queue = queue
				.then(async () => {
					if (closing) return;
					const byConversation = Map.groupBy(entries, (e) => Number(e.conversationId));
					for (const [id, some] of byConversation) await store.add(await rowsFor(harness, id, some));
				})
				.catch((error) => console.error("[history]", error));
		});
		return catchUp(harness, store);
	}

	async function catchUp(harness: Harness, store: HistoryStore): Promise<void> {
		for (const id of await homesOf(harness)) {
			const conversation = await harness.conversation(conversationId(id), background);
			if (conversation === undefined) continue;
			const from = await store.newest(id);
			let cursor;
			do {
				const page = await conversation.entries({ minEntryId: entryId(from + 1), order: "ascending" }, 200, cursor, background);
				await store.add(await rowsFor(harness, id, page.items));
				cursor = page.next;
			} while (cursor !== undefined);
		}
	}

	const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
	const unavailable = "Past conversations can't be searched here: there's no database for the index.";

	const search = defineTool({
		name: "search_history",
		description:
			`Search your past conversations with ${owner}, and your jobs' runs, for ${owner}'s messages and your answers. Every word has to appear; ` +
			`word endings don't matter. Up to 10 matches, newest first, each with its time, where it was and a number for read_history. ` +
			`Search before saying you don't know something ${owner} may have told you.`,
		parameters: Type.Object({ query: Type.String() }),
		replay: "safe",
		execute: async (args, api) => {
			if (store === undefined) return { output: [{ type: "text", text: unavailable }] };
			const agent = await agentOf(api, api.conversationId);
			const hits = await store.search(agent, args.query, MAX_HITS);
			const text = hits.length === 0 ? `Nothing in past conversations has every word of "${args.query}".` : hits.map((h) => `#${h.entryId} ${when(h.at)} (${h.place}, ${h.who === "owner" ? owner : "you"}): ${h.snippet}`).join("\n");
			return { output: [{ type: "text", text }] };
		},
	});

	const read = defineTool({
		name: "read_history",
		description: "Read the messages around a match from search_history, by its number, in order.",
		parameters: Type.Object({ id: Type.Number({ description: "The match's number, without the #" }) }),
		replay: "safe",
		execute: async (args, api) => {
			if (store === undefined) return { output: [{ type: "text", text: unavailable }] };
			const agent = await agentOf(api, api.conversationId);
			const rows = await store.around(agent, Math.round(args.id), AROUND);
			const text = rows.length === 0 ? `No match #${args.id} in your past conversations.` : rows.map((r) => `#${r.entryId} ${when(r.at)} ${r.who === "owner" ? owner : "you"}: ${r.text}`).join("\n\n");
			return { output: [{ type: "text", text }] };
		},
	});

	return {
		extension: defineExtension({ name: "history", tools: [search, read] }),
		// Past answers can repeat what a page or another agent said.
		guards: [guard("search_history", object({}), { outside: true }), guard("read_history", object({}), { outside: true })],
		attach,
	};
}
