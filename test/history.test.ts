import assert from "node:assert/strict";
import { after, before, beforeEach, test, type TestContext } from "node:test";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { NetlifyDB } from "@netlify/database-dev";
import pg from "pg";
import { postgresHistory } from "../src/history.ts";
import { openDatabaseStorage } from "../src/storage/index.ts";
import { context, openHost } from "../src/host.ts";
import { call, fauxModels, say, type Steps, toolResults, until } from "./helpers.ts";

const db = new NetlifyDB();
let url = "";
before(async () => {
	url = await db.start();
	await db.applyMigrations("netlify/database/migrations");
});
after(() => db.stop());
beforeEach(async () => {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	await client.query("TRUNCATE dreamwalker_history");
	await client.end();
});

async function start(t: TestContext, steps: Steps, storage: Storage = new MemoryStorage()) {
	const store = postgresHistory(() => url);
	const host = await openHost(storage, fauxModels(steps), { owner: "the owner", notify: async () => undefined, history: store });
	t.after(async () => {
		await host.close();
		await store.close();
	});
	await host.historyCaughtUp;
	const asked: string[] = [];
	host.approvals.onChange((r) => {
		if (r.status !== "pending") return;
		asked.push(r.summary);
		void host.approvals.decide(r.id, "deny", "test");
	});
	return { host, store, asked };
}

const indexed = (store: ReturnType<typeof postgresHistory>, agent: string, query: string) => until(async () => ((await store.search(agent, query, 10)).length > 0 ? true : undefined));

test("the owner's messages and the answers are found by every word, endings aside, newest first; tool results and workers' conversations aren't", async (t) => {
	const { host, store } = await start(t, [
		say("Noted: the boiler was serviced in March by Acme."),
		call("delegate", { task: "Find the boiler's manual." }),
		say("The manual for the Acme boilers says to bleed the radiators yearly."),
		say("Found the manual."),
		call("search_history", { query: "boilers serviced" }),
		say("In March."),
	]);
	await host.ask("My boiler was serviced in March by Acme.");
	await host.ask("Find the boiler's manual.");
	await indexed(store, "dreamwalker", "manual");
	await host.ask("When was the boiler serviced?");
	const [, search] = toolResults((await host.root.context(context)).messages);
	assert.ok(search !== undefined);
	const lines = JSON.parse(search!)[0].text.split("\n");
	// The question just asked is found too, newest.
	assert.equal(lines.length, 3, lines.join(" | "));
	assert.match(lines[0], /\(conversation, the owner\): When was the \*\*boiler\*\* \*\*serviced\*\*\?/);
	assert.match(lines[1], /^#\d+ .* \(conversation, you\): Noted: the \*\*boiler\*\* was \*\*serviced\*\*/);
	assert.match(lines[2], /\(conversation, the owner\): My \*\*boiler\*\* was \*\*serviced\*\*/);
	assert.deepEqual(await store.search("dreamwalker", "bleed radiators", 10), [], "the worker's answer isn't indexed");
});

test("read_history shows the messages around a match, in order", async (t) => {
	const { host, store } = await start(t, [say("One."), say("Two, the heron."), say("Three.")]);
	for (const word of ["first", "second, about herons", "third"]) await host.ask(word);
	await indexed(store, "dreamwalker", "three");
	const [hit] = await store.search("dreamwalker", "heron", 10);
	const around = await store.around("dreamwalker", hit!.entryId, 1);
	assert.deepEqual(
		around.map((r) => r.text),
		["second, about herons", "Two, the heron.", "third"],
	);
});

test("an agent finds only its own past conversations", async (t) => {
	const { host, store } = await start(t, [say("Tomatoes go in bed 2."), say("Hi.")]);
	await host.agents.add({ name: "Sage", job: "Garden questions." });
	await host.ask("Where do the tomatoes go?", undefined, "cli", "sage");
	await host.ask("hello");
	await indexed(store, "sage", "tomatoes");
	assert.deepEqual(await store.search("dreamwalker", "tomatoes", 10), []);
	assert.equal((await store.search("sage", "tomatoes", 10)).length, 2);
	assert.ok((await store.search("sage", "tomatoes", 10)).every((h) => h.place === "conversation"), "an agent added later is a conversation, not a job run");
});

test("history written before the index is caught up when the host opens", async (t) => {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	await client.query("TRUNCATE pi_record_ids, pi_conversations, pi_entries, pi_tasks, pi_submissions, pi_documents, pi_document_revisions, dreamwalker_lease");
	await client.query("UPDATE pi_durable_metadata SET next_id = '2', next_seq = 1");
	await client.end();
	const storage = () => openDatabaseStorage({ connectionString: () => url });
	const first = await openHost(await storage(), fauxModels([say("The spare key is under the blue pot.")]), { notify: async () => undefined });
	await first.ask("Where's the spare key?");
	await first.close();
	const { store } = await start(t, [], await storage());
	assert.equal((await store.search("dreamwalker", "spare key", 10)).length, 2);
});

test("what search_history returns is outside text, so writing a note afterwards asks", async (t) => {
	const { host, asked } = await start(t, [say("Noted."), call("search_history", { query: "coffee" }), call("remember", { text: "Likes coffee." }), say("Done.")]);
	await host.ask("I drink coffee black.");
	await host.ask("what did I say about coffee? remember it");
	assert.deepEqual(asked, [`remember "Likes coffee.", after reading outside text (search_history)`]);
});
