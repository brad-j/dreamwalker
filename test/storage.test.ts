import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { NetlifyDB } from "@netlify/database-dev";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import pg from "pg";
import { createApi } from "../src/api.ts";
import { envFrom } from "../src/environment.ts";
import { context, openHost } from "../src/host.ts";
import { startInstance } from "../src/instance.ts";
import { Credentials, modelFor } from "../src/model.ts";
import { nodeAssertions } from "../src/sandbox-check.ts";
import { holderFor, openDatabaseStorage } from "../src/storage/index.ts";
import { LeaseLost } from "../src/storage/lease.ts";
import { PostgresDatabase, toPostgres } from "../src/storage/postgres.ts";

const db = new NetlifyDB();
let url = "";
const connectionString = () => url;

before(async () => {
	url = await db.start();
	await db.applyMigrations("netlify/database/migrations");
});
after(() => db.stop());

/** Empties every table, as a fresh deploy's database would be. */
async function reset() {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	await client.query(`TRUNCATE pi_record_ids, pi_conversations, pi_entries, pi_tasks, pi_submissions, pi_documents, pi_document_revisions, dreamwalker_lease`);
	await client.query(`UPDATE pi_durable_metadata SET next_id = '2', next_seq = 1`);
	await client.end();
}

describe("Pi Durable's storage conformance on Netlify Database", () => {
	const cases = createStorageConformance({
		assertions: nodeAssertions,
		withStorage: async (use) => {
			await reset();
			const storage = await openDatabaseStorage({ connectionString });
			try {
				await use(storage);
			} finally {
				await storage.close(context);
			}
		},
	});
	for (const c of cases) test(c.name, () => c.run());
});

describe("the Postgres facade", () => {
	test("placeholders are numbered and INSERT OR IGNORE does nothing on conflict", () => {
		assert.equal(toPostgres("SELECT a FROM t WHERE b = ? AND c = 'x?' LIMIT ?"), "SELECT a FROM t WHERE b = $1 AND c = 'x?' LIMIT $2");
		assert.equal(toPostgres("INSERT OR IGNORE INTO t (a) VALUES (?)"), "INSERT INTO t (a) VALUES ($1) ON CONFLICT DO NOTHING");
	});

	test("big integers come back as numbers", async () => {
		const database = new PostgresDatabase({ connectionString });
		assert.deepEqual(await database.get("SELECT ?::bigint AS n", 9_007_199_254_740_991), { n: 9_007_199_254_740_991 });
		await database.close();
	});

	test("a schema change is refused and names the migrations", async () => {
		const database = new PostgresDatabase({ connectionString });
		await assert.rejects(database.exec("CREATE TABLE pi_new (id INTEGER)"), /netlify\/database\/migrations/);
		await database.exec("CREATE TABLE IF NOT EXISTS pi_durable_schema (singleton INTEGER)");
		await database.close();
	});

	test("a failed transaction is rolled back", async () => {
		const database = new PostgresDatabase({ connectionString });
		await assert.rejects(
			database.transaction(async (tx) => {
				await tx.run("UPDATE pi_durable_metadata SET next_seq = 999");
				throw new Error("no");
			}),
			/no/,
		);
		assert.notEqual((await database.get<{ next_seq: number }>("SELECT next_seq FROM pi_durable_metadata"))?.next_seq, 999);
		await database.close();
	});
});

describe("the lease", () => {
	test("a newer deploy takes over, and the old instance can't commit after", async () => {
		await reset();
		const old = await openDatabaseStorage({ connectionString, holder: { id: "old", generation: "0001" } });
		await old.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
		const next = await openDatabaseStorage({ connectionString, holder: { id: "new", generation: "0002" } });
		const another = await old.mintId();
		// SAFETY: a minted ID names whatever record it's first written as.
		await assert.rejects(old.commit([{ type: "conversation", value: { id: another as typeof ROOT_CONVERSATION_ID } }], context), (error) => error instanceof LeaseLost);
		assert.ok(await next.conversation(ROOT_CONVERSATION_ID, context));
		await next.close(context);
		await old.close(context);
	});

	test("an older deploy waits for the lease and gives up", async () => {
		await reset();
		const current = await openDatabaseStorage({ connectionString, holder: { id: "current", generation: "0002" } });
		await assert.rejects(openDatabaseStorage({ connectionString, holder: { id: "stale", generation: "0001" }, waitMs: 300, pollMs: 100 }), /holds the storage lease/);
		await current.close(context);
	});

	test("closing gives the lease up, so even an older deploy can take it at once", async () => {
		await reset();
		const current = await openDatabaseStorage({ connectionString, holder: { id: "current", generation: "0002" } });
		await current.close(context);
		const older = await openDatabaseStorage({ connectionString, holder: { id: "older", generation: "0001" }, waitMs: 0 });
		await older.close(context);
	});
});

test("a conversation survives a restart", async () => {
	await reset();
	const first = await openHost(await openDatabaseStorage({ connectionString }), modelFor({ provider: "faux" }));
	assert.deepEqual(await first.ask("remember this"), { ok: true, text: 'You said: "remember this"' });
	await first.close();

	const second = await openHost(await openDatabaseStorage({ connectionString }), modelFor({ provider: "faux" }));
	assert.equal(second.root.id, first.root.id);
	const view = await second.root.viewState(context);
	const said = view.value.entries.map((e) => e.kind);
	view.dispose();
	assert.deepEqual(said.filter((k) => k === "pi.user" || k === "pi.assistant"), ["pi.user", "pi.assistant"]);
	await second.close();
});

test("an instance whose lease was taken stops and says so", async () => {
	await reset();
	const old = startInstance(() => openDatabaseStorage({ connectionString, holder: { id: "old", generation: "0001" } }), modelFor({ provider: "faux" }));
	const oldHost = (await old.host())!;
	const next = startInstance(() => openDatabaseStorage({ connectionString, holder: { id: "new", generation: "0002" } }), modelFor({ provider: "faux" }));
	await next.host();
	await assert.rejects(oldHost.ask("too late"));
	await oldHost.harness.closed;
	assert.equal(await old.host(), undefined);
	const response = await createApi(old, { token: "t", local: false, credentials: new Credentials(), env: envFrom({}), see: () => undefined, describe: () => ({}) })(new Request("http://dreamwalker.test/api/wake"));
	assert.equal(response.status, 503);
	await next.close();
	await old.close();
});

test("a conversation started on one model carries on with the one the site is set to", async () => {
	await reset();
	const first = await openHost(await openDatabaseStorage({ connectionString }), modelFor({ provider: "faux" }));
	assert.equal((await first.ask("before")).ok, true);
	await first.close();
	// Another provider entirely, as when the faux model gives way to Claude: the old one isn't registered any more.
	const faux2 = fauxProvider({ provider: "faux-two", models: [{ id: "two" }] });
	faux2.setResponses([fauxAssistantMessage(fauxText("from the new model"))]);
	const models = createModels();
	models.setProvider(faux2.provider);
	const second = await openHost(await openDatabaseStorage({ connectionString }), { models, model: { provider: "faux-two", modelId: "two" } });
	assert.deepEqual(await second.ask("after"), { ok: true, text: "from the new model" });
	await second.close();
});

test("an instance is ranked by the deploy its first request reached, each start a new holder", () => {
	const first = holderFor("6ad8cca7064787a9e80d52a3");
	assert.equal(first.generation, "6ad8cca7064787a9e80d52a3");
	assert.notEqual(holderFor("6ad8cca7064787a9e80d52a3").id, first.id);
	assert.ok(holderFor("6ad8cb11c77612b6704cade1").generation < first.generation, "an older deploy sorts first");
});
