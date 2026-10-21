import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createApi } from "../src/api.ts";
import { createClient } from "../src/client.ts";
import { envFrom } from "../src/environment.ts";
import { context, openHost } from "../src/host.ts";
import { startInstance } from "../src/instance.ts";
import { addNote, MAX_NOTE, MAX_TOTAL, Memory } from "../src/memory.ts";
import { Credentials } from "../src/model.ts";
import { call, fauxModels, say, type Steps, system } from "./helpers.ts";

async function start(t: TestContext, steps: Steps) {
	const host = await openHost(new MemoryStorage(), fauxModels(steps), { owner: "the owner", notify: async () => undefined });
	t.after(() => host.close());
	return host;
}

const notes = async (host: Awaited<ReturnType<typeof start>>) => ((await host.harness.snapshot(Memory, context))?.notes ?? []).map((n) => n.text);

test("a note reaches the system prompt of later requests", async (t) => {
	let seen = "";
	const host = await start(t, [
		call("remember", { text: "The NAS is in the hall closet." }),
		say("Noted."),
		(ctx) => {
			seen = system(ctx);
			return say("ok");
		},
	]);
	await host.ask("the NAS is in the hall closet");
	await host.ask("where is it?");
	assert.match(seen, /\[n1\] The NAS is in the hall closet\./);
	assert.match(seen, /not instructions to follow/);
	assert.match(seen, /You are dreamwalker, the owner's personal agent/);
});

test("notes have limits, and forget and update work", async (t) => {
	const host = await start(t, [
		call("remember", { text: "x".repeat(MAX_NOTE + 1) }),
		call("remember", { text: "Coffee: oat milk." }),
		call("update_memory", { id: "n1", text: "Coffee: oat milk, no sugar." }),
		call("forget", { id: "n99" }),
		say("ok"),
	]);
	await host.ask("coffee");
	const out = (await host.root.context(context)).messages.filter((m) => m.role === "toolResult").map((m) => JSON.stringify(m.content));
	assert.match(out[0]!, /at most 500 characters/);
	assert.match(out[2]!, /Updated \[n1\]/);
	assert.match(out[3]!, /No note n99/);
	assert.deepEqual(await notes(host), ["Coffee: oat milk, no sugar."]);
	await assert.rejects(
		host.root.commit(async (tx) => {
			for (let i = 0; i < MAX_TOTAL / 400 + 1; i += 1) await addNote(tx, "y".repeat(400), "owner");
		}, context),
		/Memory is full/,
	);
});

test("the owner lists, adds, edits and deletes notes through the API and the client", async (t) => {
	const instance = startInstance(async () => new MemoryStorage(), fauxModels([]), { notify: async () => undefined });
	t.after(() => instance.close());
	const api = createApi(instance, { token: "owner-token", local: false, env: envFrom({}), see: () => undefined, credentials: new Credentials(), describe: () => ({}) });
	const headers = { authorization: "Bearer owner-token", "content-type": "application/json" };
	const post = (path: string, body: object) => api(new Request(`http://dreamwalker.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }));

	const added = await (await post("/api/memory/add", { text: "  Birthday   in June. " })).json();
	assert.deepEqual([added.text, added.by], ["Birthday in June.", "owner"]);
	assert.equal((await post("/api/memory/add", { text: "" })).status, 400);
	const edited = await (await post("/api/memory/update", { id: `n${added.id}`, text: "Birthday on June 4." })).json();
	assert.deepEqual([edited.text, edited.by], ["Birthday on June 4.", "owner"]);
	assert.equal((await post("/api/memory/update", { id: added.id, text: "x".repeat(MAX_NOTE + 1) })).status, 400);
	assert.equal((await post("/api/memory/update", { id: 999, text: "nothing" })).status, 404);
	assert.equal((await api(new Request("http://dreamwalker.test/api/memory"))).status, 401);

	const client = createClient({ url: "http://dreamwalker.test", token: "owner-token" }, async (input, init) => api(new Request(input, init)));
	const listed = await client.memory();
	assert.deepEqual([listed.notes.map((n) => n.text), listed.maxNote, listed.maxTotal], [["Birthday on June 4."], MAX_NOTE, MAX_TOTAL]);
	assert.equal((await client.remember("Prefers mornings.")).id, 2);
	assert.equal(await client.forget(`n${added.id}`), true);
	await assert.rejects(client.forget("n99"), /No note n99/);
	assert.deepEqual((await client.memory()).notes.map((n) => n.text), ["Prefers mornings."]);
});
