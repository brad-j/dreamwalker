import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createApi } from "../src/api.ts";
import { envFrom } from "../src/environment.ts";
import { context } from "../src/host.ts";
import { startInstance } from "../src/instance.ts";
import { Jobs } from "../src/jobs.ts";
import { addNote, Memory } from "../src/memory.ts";
import { Credentials } from "../src/model.ts";
import { Reminders } from "../src/reminders.ts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { call, fauxModels, say, type Steps, system, until } from "./helpers.ts";

async function start(t: TestContext, steps: Steps) {
	const instance = startInstance(async () => new MemoryStorage(), fauxModels(steps), { owner: "the owner", notify: async () => undefined });
	t.after(() => instance.close());
	const api = createApi(instance, { token: "t", local: false, env: envFrom({}), see: () => undefined, credentials: new Credentials(), describe: () => ({}) });
	const headers = { authorization: "Bearer t", "content-type": "application/json" };
	const post = (path: string, body: object) => api(new Request(`http://dreamwalker.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
	const get = async (path: string) => (await api(new Request(`http://dreamwalker.test${path}`, { headers }))).json();
	const host = (await instance.host())!;
	const asked: { summary: string; agent?: string }[] = [];
	host.approvals.onChange((r) => {
		if (r.status !== "pending") return;
		asked.push(r.agent === undefined ? { summary: r.summary } : { summary: r.summary, agent: r.agent });
		void host.approvals.decide(r.id, r.tool === "schedule_job" ? "once" : "deny", "test");
	});
	const sage = async (fields: object = {}) => (await post("/api/agents/add", { name: "Sage", job: "Answers questions about the owner's garden.", ...fields })).json();
	return { host, post, get, asked, sage };
}

test("an agent the owner adds has its own conversation, and its prompt names it with its job and instructions", async (t) => {
	let prompt = "";
	let rootPrompt = "";
	const { host, post, get, sage } = await start(t, [
		(ctx) => {
			prompt = system(ctx);
			return say("Water them in the morning.");
		},
		(ctx) => {
			rootPrompt = system(ctx);
			return say("Hi.");
		},
	]);
	const added = await sage({ instructions: "Answer in one sentence." });
	assert.equal(added.id, "sage");
	assert.deepEqual(
		(await get("/api/agents")).agents.map((a: { id: string }) => a.id),
		["dreamwalker", "sage"],
	);
	const answered = await (await post("/api/ask", { message: "When should I water the tomatoes?", agent: "sage" })).json();
	assert.equal(answered.answer, "Water them in the morning.");
	await post("/api/ask", { message: "hello" });
	assert.match(prompt, /You are Sage, one of the owner's agents, beside dreamwalker, their personal agent\. Your job: Answers questions about the owner's garden\./);
	assert.match(prompt, /standing instructions for you:\\nAnswer in one sentence\./);
	assert.match(rootPrompt, /You are dreamwalker, the owner's personal agent\./);
	const sages = (await get("/api/transcript?agent=sage")).lines.map((l: { kind: string; text?: string }) => `${l.kind}: ${l.text}`);
	assert.deepEqual(sages, ["you: When should I water the tomatoes?", "answer: Water them in the morning."]);
	assert.ok(!(await get("/api/transcript")).lines.some((l: { text?: string }) => /tomatoes/.test(l.text ?? "")), "dreamwalker's conversation doesn't have it");
	assert.equal(host.root.id !== added.conversationId, true);
});

test("names are checked: a duplicate, dreamwalker's own, or an empty job is refused; an unknown agent is 404", async (t) => {
	const { post, sage } = await start(t, []);
	await sage();
	assert.equal((await post("/api/agents/add", { name: "sage", job: "Again." })).status, 400);
	assert.equal((await post("/api/agents/add", { name: "Dreamwalker", job: "Me." })).status, 400);
	assert.equal((await post("/api/agents/add", { name: "Moss", job: " " })).status, 400);
	assert.equal((await post("/api/ask", { message: "hi", agent: "nobody" })).status, 404);
	assert.equal((await post("/api/agents/update", { id: "nobody", job: "x" })).status, 404);
});

test("an agent sees the shared notes and its own work notes, writes work notes unless asked to share, and can't touch another's", async (t) => {
	let prompt = "";
	let rootPrompt = "";
	const { host, post, asked, sage } = await start(t, [
		call("remember", { text: "Tomatoes are in bed 2." }),
		call("remember", { text: "The owner likes heirloom tomatoes.", shared: true } as never),
		(ctx) => {
			prompt = system(ctx);
			return say("Noted.");
		},
		(ctx) => {
			rootPrompt = system(ctx);
			return call("forget", { id: "n2" });
		},
		say("Done."),
	]);
	await host.root.commit((tx) => addNote(tx, "The owner lives in a cold climate.", "owner"), context);
	await sage();
	await post("/api/ask", { message: "Tomatoes are in bed 2, and I like heirlooms.", agent: "sage" });
	const notes = (await host.harness.snapshot(Memory, context))!.notes.map((n) => [n.id, n.text, n.agent]);
	assert.deepEqual(notes, [
		[1, "The owner lives in a cold climate.", undefined],
		[2, "Tomatoes are in bed 2.", "sage"],
		[3, "The owner likes heirloom tomatoes.", undefined],
	]);
	assert.match(prompt, /shared by all of the owner's agents[^]*\[n1\] The owner lives in a cold climate\.[^]*Your own work notes, which only you see:\\n\[n2\] Tomatoes are in bed 2\./);
	await post("/api/ask", { message: "forget n2" });
	assert.deepEqual(asked, []);
	assert.match(rootPrompt, /\[n3\] The owner likes heirloom tomatoes\./);
	assert.doesNotMatch(rootPrompt, /bed 2/);
	assert.equal((await host.harness.snapshot(Memory, context))!.notes.length, 3, "dreamwalker can't forget sage's work note");
});

test("an agent without the shared notes doesn't see them and can't write one", async (t) => {
	let prompt = "";
	const { host, post, sage } = await start(t, [
		call("remember", { text: "Shared fact.", shared: true } as never),
		(ctx) => {
			prompt = system(ctx);
			return say("Couldn't.");
		},
	]);
	await host.root.commit((tx) => addNote(tx, "The owner lives in a cold climate.", "owner"), context);
	await sage({ sharedNotes: false });
	await post("/api/ask", { message: "remember a shared fact", agent: "sage" });
	assert.doesNotMatch(prompt, /cold climate/);
	assert.equal((await host.harness.snapshot(Memory, context))!.notes.length, 1);
});

test("an agent's reminders and jobs are its own: it lists and cancels only those, and its job runs as it", async (t) => {
	const at = new Date(Date.now() + 300).toISOString();
	let runPrompt = "";
	let target = 0;
	const { host, post, get, asked, sage } = await start(t, [
		call("remind", { text: "Water the roses.", inMinutes: "600" }),
		say("Set."),
		call("schedule_job", { title: "Frost check", instruction: "Check for frost.", at }),
		call("list_reminders", {}),
		() => fauxAssistantMessage(fauxToolCall("cancel_reminder", { id: target }), { stopReason: "toolUse" }),
		say("Done."),
		(ctx) => {
			runPrompt = system(ctx);
			return say("No frost tonight.");
		},
	]);
	await post("/api/ask", { message: "remind me to water the roses in 10 hours" });
	const dreamwalkers = (await host.harness.snapshot(Reminders, context))!.items[0]!;
	target = dreamwalkers.taskId;
	await sage();
	const steps = await post("/api/ask", { message: "schedule a frost check, then list and cancel reminders", agent: "sage" });
	assert.equal(steps.status, 200);
	assert.equal(asked[0]!.agent, "sage");
	const results = (await get("/api/transcript?agent=sage")).lines.filter((l: { kind: string }) => l.kind === "tool").map((l: { name: string; result?: string }) => `${l.name}: ${l.result}`);
	assert.ok(results.some((r: string) => r === "list_reminders: No open reminders."), results.join(" | "));
	assert.ok(results.some((r: string) => r === `cancel_reminder: No open reminder ${target}.`), results.join(" | "));
	const reminders = (await host.harness.snapshot(Reminders, context))!.items;
	assert.deepEqual(
		reminders.map((r) => r.taskId),
		[dreamwalkers.taskId],
		"sage couldn't cancel dreamwalker's reminder",
	);
	const job = (await host.harness.snapshot(Jobs, context))!.items[0];
	assert.equal(job?.agent, "sage");
	await until(async () => ((await host.harness.snapshot(Jobs, context))?.items.length === 0 ? true : undefined));
	assert.match(runPrompt, /You are Sage/);
});

test("archiving an agent pauses its jobs, cancels its reminders and closes its conversation; restoring opens it, jobs still paused", async (t) => {
	const at = new Date(Date.now() + 3_600_000).toISOString();
	const { host, post, sage } = await start(t, [
		call("remind", { text: "Water the roses.", inMinutes: "600" }),
		call("schedule_job", { title: "Frost check", instruction: "Check for frost.", at }),
		say("Set."),
		say("Back."),
	]);
	await sage();
	await post("/api/ask", { message: "remind me and schedule a frost check", agent: "sage" });
	assert.equal((await host.harness.snapshot(Reminders, context))!.items.length, 1);
	assert.equal((await post("/api/agents/archive", { id: "sage" })).status, 200);
	assert.equal((await host.harness.snapshot(Reminders, context))!.items.length, 0);
	assert.match((await host.harness.snapshot(Jobs, context))!.items[0]!.paused?.reason ?? "", /Sage was archived/);
	assert.equal((await post("/api/ask", { message: "hi", agent: "sage" })).status, 409);
	assert.equal((await post("/api/agents/restore", { id: "sage" })).status, 200);
	assert.equal((await post("/api/ask", { message: "hi", agent: "sage" })).status, 200);
	assert.ok((await host.harness.snapshot(Jobs, context))!.items[0]!.paused !== undefined, "its job stays paused");
});
