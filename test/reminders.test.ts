import assert from "node:assert/strict";
import { after, before, test, type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type Conversation, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { NetlifyDB } from "@netlify/database-dev";
import pg from "pg";
import { context, openHost } from "../src/host.ts";
import type { Adapters } from "../src/notifications.ts";
import { ntfyAdapter, ntfySettingsFrom } from "../src/ntfy.ts";
import { ReminderFired, type Reminder, Reminders, soon } from "../src/reminders.ts";
import { openDatabaseStorage } from "../src/storage/index.ts";
import { setTimeZone, stamp, timeZone } from "../src/time.ts";

const db = new NetlifyDB();
let url = "";
before(async () => {
	url = await db.start();
	await db.applyMigrations("netlify/database/migrations");
});
after(() => db.stop());

function fauxModels(steps: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0] = []) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(steps);
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

/** A way to reach the owner that keeps the reminders it's sent, failing the first `failFirst`. */
function recorder(failFirst = 0) {
	const sent: Reminder[] = [];
	let failures = 0;
	const adapters: Adapters = {
		ntfy: {
			send: async (notice) => {
				if (notice.kind !== "reminder") return true;
				if (failures < failFirst) {
					failures += 1;
					throw new Error("ntfy down");
				}
				sent.push(notice.reminder);
				return true;
			},
		},
	};
	return { sent, adapters };
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
	const end = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 50));
	}
}

async function firedEntries(root: Conversation) {
	const page = await root.commit((tx) => tx.scanEntries({ conversationId: root.id }, 100), context);
	return page.items.filter((entry) => ReminderFired.is(entry));
}

async function start(t: TestContext, adapters: Adapters, steps: Parameters<typeof fauxModels>[0] = [], storage: Storage = new MemoryStorage()) {
	const host = await openHost(storage, fauxModels(steps), { adapters, notify: async () => undefined });
	t.after(() => host.close());
	return host;
}

/** A reminder set straight in the storage, as the remind tool would, firing at `at`. */
const setReminder = (host: Awaited<ReturnType<typeof start>>, text: string, at: number) =>
	host.root.commit(async (tx) => {
		const id = await tx.createTask(host.reminders.ReminderTask, { text, at }, { ownership: { kind: "conversation" }, background: true });
		(await tx.doc(Reminders)).items.push({ taskId: id, text, at });
		return id;
	}, context);

test("the remind tool schedules a push that fires and leaves a transcript record", async (t) => {
	const { sent, adapters } = recorder();
	const host = await start(t, adapters, [fauxAssistantMessage(fauxToolCall("remind", { text: "stretch", inMinutes: 0.01 }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("Set."))]);
	assert.deepEqual(await host.ask("remind me to stretch"), { ok: true, text: "Set." });
	assert.equal((await host.harness.snapshot(Reminders, context))?.items.length, 1);

	await until(() => sent.length === 1);
	assert.equal(sent[0]!.text, "stretch");
	await until(async () => (await firedEntries(host.root)).length === 1);
	assert.deepEqual((await host.harness.snapshot(Reminders, context))?.items, []);
});

test("a reminder sleeping across a restart fires in the next process", async (t) => {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	await client.query("TRUNCATE pi_record_ids, pi_conversations, pi_entries, pi_tasks, pi_submissions, pi_documents, pi_document_revisions, dreamwalker_lease");
	await client.query("UPDATE pi_durable_metadata SET next_id = '2', next_seq = 1");
	await client.end();
	const storage = () => openDatabaseStorage({ connectionString: () => url });

	const first = await openHost(await storage(), fauxModels(), { adapters: recorder().adapters, notify: async () => undefined });
	const at = Date.now() + 1500;
	await setReminder(first, "after restart", at);
	await first.close();

	const { sent, adapters } = recorder();
	await start(t, adapters, [], await storage());
	await until(() => sent.length === 1);
	assert.equal(sent[0]!.text, "after restart");
	assert.ok(Date.now() >= at);
});

test("a cancelled reminder finishes without pushing", async (t) => {
	const { sent, adapters } = recorder();
	const host = await start(t, adapters);
	const id = await setReminder(host, "never", Date.now() + 800);
	await host.root.commit(async (tx) => {
		const doc = await tx.doc(Reminders);
		doc.items = doc.items.filter((r) => r.taskId !== id);
	}, context);
	const { outcome } = (await host.harness.waitForTask(id, context)).state;
	assert.deepEqual(outcome, { status: "completed", result: "cancelled" });
	assert.equal(sent.length, 0);
});

test("a failed push is retried", async (t) => {
	const { sent, adapters } = recorder(1);
	const host = await start(t, adapters);
	const id = await setReminder(host, "retry me", Date.now());
	const { outcome } = (await host.harness.waitForTask(id, context)).state;
	assert.deepEqual(outcome, { status: "completed", result: "sent" });
	assert.equal(sent.length, 1);
});

test("list and cancel go through the tools", async (t) => {
	const { sent, adapters } = recorder();
	let openId = 0;
	const lastToolOutput = (ctx: { messages: readonly { content?: unknown }[] }) => fauxAssistantMessage(fauxText(JSON.stringify(ctx.messages.at(-1)?.content)));
	const host = await start(t, adapters, [
		fauxAssistantMessage(fauxToolCall("remind", { text: "later", inMinutes: 60 }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("Set.")),
		fauxAssistantMessage(fauxToolCall("list_reminders", {}), { stopReason: "toolUse" }),
		lastToolOutput,
		() => fauxAssistantMessage(fauxToolCall("cancel_reminder", { id: openId }), { stopReason: "toolUse" }),
		lastToolOutput,
	]);
	await host.ask("remind me later");
	const [open] = (await host.harness.snapshot(Reminders, context))?.items ?? [];
	assert.ok(open);
	openId = open.taskId;
	const listed = await host.ask("what's open?");
	assert.ok(listed.ok && listed.text.includes(`${open.taskId}: `) && listed.text.includes(": later"));
	const cancelled = await host.ask("cancel it");
	assert.ok(cancelled.ok && cancelled.text.includes(`Cancelled ${open.taskId}: later`));
	assert.deepEqual((await host.harness.snapshot(Reminders, context))?.items, []);
	assert.equal(sent.length, 0);
});

test("messages carry the local time, and a timer under an hour is confirmed to the second", (t) => {
	const zone = timeZone();
	t.after(() => setTimeZone(zone));
	setTimeZone("UTC");
	const now = Date.UTC(2026, 9, 18, 20, 15, 20);
	assert.equal(stamp("hi", now), "[Sun 2026-10-18 20:15 GMT] hi");
	assert.equal(soon(now + 20_000, now), " (20:15:40, in 20 seconds)");
	assert.equal(soon(now + 125_000, now), " (20:17:25, in 2 min 5 s)");
	assert.equal(soon(now + 3_600_000, now), "");
});

test("ntfy gets the reminder as an alarm and a budget warning as text, with the token", async () => {
	const posts: { url: string; body: string; headers: Headers }[] = [];
	const adapter = ntfyAdapter({ url: "https://ntfy.example.com/topic", token: "tk" }, async (input, init) => {
		posts.push({ url: String(input), body: String(init?.body), headers: new Headers(init?.headers) });
		return new Response("ok");
	});
	assert.equal(await adapter.send({ kind: "reminder", reminder: { taskId: 1, text: "stretch", at: 0 } }), true);
	assert.equal(await adapter.send({ kind: "budget", text: "80%" }), true);
	assert.deepEqual(
		posts.map((p) => [p.url, p.body, p.headers.get("title"), p.headers.get("authorization")]),
		[
			["https://ntfy.example.com/topic", "stretch", "dreamwalker", "Bearer tk"],
			["https://ntfy.example.com/topic", "80%", "dreamwalker: budget", "Bearer tk"],
		],
	);
	const failing = ntfyAdapter({ url: "https://ntfy.example.com/topic" }, async () => new Response("no", { status: 403 }));
	await assert.rejects(failing.send({ kind: "budget", text: "x" }), /ntfy answered 403/);
});

test("ntfy settings come from the environment", () => {
	assert.equal(ntfySettingsFrom({}), undefined);
	assert.deepEqual(ntfySettingsFrom({ NTFY_URL: "https://ntfy.example.com/t" }), { url: "https://ntfy.example.com/t" });
	assert.deepEqual(ntfySettingsFrom({ NTFY_URL: "https://ntfy.example.com/t", NTFY_TOKEN: "tk" }), { url: "https://ntfy.example.com/t", token: "tk" });
	assert.throws(() => ntfySettingsFrom({ NTFY_URL: "not a url" }));
});
