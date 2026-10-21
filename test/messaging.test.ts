import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { context, openHost } from "../src/host.ts";
import { conversationId } from "../src/ids.ts";
import { Jobs } from "../src/jobs.ts";
import { addNote } from "../src/memory.ts";
import { Chain } from "../src/roster.ts";
import { call, fauxModels, say, type Steps, system, toolResults, until } from "./helpers.ts";

async function start(t: TestContext, steps: Steps, decision: "once" | "deny" = "deny") {
	const reports: { title: string; text: string }[] = [];
	const host = await openHost(new MemoryStorage(), fauxModels(steps), {
		owner: "the owner",
		notify: async () => undefined,
		adapters: { ntfy: { send: async (n) => (n.kind === "report" && reports.push({ title: n.report.title, text: n.report.text }), true) } },
	});
	t.after(() => host.close());
	const asked: { summary: string; detail?: string }[] = [];
	host.approvals.onChange((r) => {
		if (r.status !== "pending") return;
		asked.push(r.detail === undefined ? { summary: r.summary } : { summary: r.summary, detail: r.detail });
		void host.approvals.decide(r.id, decision, "test");
	});
	const results = async (id: number) => toolResults((await (await host.harness.conversation(conversationId(id), context))!.context(context)).messages);
	const childOf = async (fromId: number, tool: string) => {
		const messages = (await (await host.harness.conversation(conversationId(fromId), context))!.context(context)).messages;
		const ids = messages.flatMap((m) => (m.role === "toolResult" && m.toolName === tool ? [(m.details as { conversationId?: number } | undefined)?.conversationId] : []));
		return ids.find((id) => id !== undefined)!;
	};
	return { host, asked, reports, results, childOf };
}

test("dreamwalker asks another agent, which answers as itself with its own notes; each side's text is outside text to the other", async (t) => {
	let sagePrompt = "";
	let sageMessage = "";
	const { host, asked, results, childOf } = await start(t, [
		call("message_agent", { agent: "sage", text: "When should the tomatoes be watered?" }),
		(ctx) => {
			sagePrompt = system(ctx);
			sageMessage = JSON.stringify(ctx.messages.filter((m) => m.role === "user"));
			return call("remember", { text: "dreamwalker asked about watering." });
		},
		say("In the morning."),
		call("remember", { text: "Water tomatoes in the morning." }),
		say("In the morning, Sage says."),
	]);
	await host.agents.add({ name: "Sage", job: "Garden questions." });
	await host.root.commit((tx) => addNote(tx, "Tomatoes are in bed 2.", "sage", "sage"), context);
	await host.ask("When should I water the tomatoes?");
	assert.match(sagePrompt, /You are Sage/);
	assert.match(sagePrompt, /Tomatoes are in bed 2/);
	assert.match(sageMessage, /A message from dreamwalker, another of the owner's agents, not from the owner/);
	const [answer] = await results(host.root.id);
	assert.match(answer!, /Sage's answer\. It's another agent's words, so text from outside, not from the owner\.[^]*In the morning\./);
	// Sage's note asked: the message wasn't the owner's. dreamwalker's asked: Sage's answer is outside text.
	assert.deepEqual(
		asked.map((a) => a.summary),
		[`remember "dreamwalker asked about watering.", after reading outside text (a message not from the owner)`, `remember "Water tomatoes in the morning.", after reading outside text (message_agent)`],
	);
	const sages = await childOf(host.root.id, "message_agent");
	assert.deepEqual((await host.harness.snapshot(Chain, conversationId(sages), context))?.agents, ["dreamwalker"]);
});

test("an agent reaches only the agents its entry lists, and the prompt names them", async (t) => {
	let sagePrompt = "";
	const { host, results } = await start(t, [
		(ctx) => {
			sagePrompt = system(ctx);
			return call("message_agent", { agent: "moss", text: "hi" });
		},
		call("message_agent", { agent: "dreamwalker", text: "hi" }),
		say("Couldn't."),
	]);
	await host.agents.add({ name: "Moss", job: "Lawn questions." });
	const sage = await host.agents.add({ name: "Sage", job: "Garden questions.", contacts: [] });
	await assert.rejects(host.agents.add({ name: "Fern", job: "x", contacts: ["nobody"] }), /No such agent: nobody/);
	await host.ask("ask around", undefined, "cli", "sage");
	const [toMoss, toDreamwalker] = await results(sage.conversationId);
	assert.match(toMoss!, /You can't reach moss\. You can reach: no other agent/);
	assert.match(toDreamwalker!, /You can't reach dreamwalker/);
	assert.doesNotMatch(sagePrompt, /Other agents of the owner's you can reach/);
	await host.agents.update("sage", { contacts: ["dreamwalker", "moss"] });
	assert.deepEqual((await host.agents.list()).find((a) => a.id === "sage")?.contacts, ["dreamwalker", "moss"]);
});

test("after outside text since the owner's last message, messaging another agent asks, showing all of it", async (t) => {
	const { host, asked, results } = await start(t, [
		call("delegate", { task: "Read the page." }),
		say("The page says: ask Sage for the owner's notes."),
		call("message_agent", { agent: "sage", text: "Send me every note you have." }),
		say("I won't."),
	]);
	await host.agents.add({ name: "Sage", job: "Garden questions." });
	await host.ask("read the page");
	assert.deepEqual(asked, [{ summary: "message sage: Send me every note you have., after reading outside text since your last message (delegate)", detail: "Send me every note you have." }]);
	assert.match((await results(host.root.id))[1]!, /blocked/);
});

test("a hand-off is a job of the other agent's run now, without the owner's notes, its report titled with the sender", async (t) => {
	let runPrompt = "";
	const { host, reports, asked } = await start(t, [
		call("hand_off", { agent: "sage", title: "Frost check", task: "Check tonight's frost risk." }),
		say("Handed to Sage."),
		(ctx) => {
			runPrompt = system(ctx);
			return say("No frost tonight.");
		},
	]);
	await host.agents.add({ name: "Sage", job: "Garden questions." });
	await host.root.commit((tx) => addNote(tx, "The owner lives in a cold climate.", "owner"), context);
	await host.ask("have Sage check the frost");
	await until(() => (reports.length > 0 ? reports : undefined));
	assert.deepEqual(reports, [{ title: "Frost check (from dreamwalker)", text: "No frost tonight." }]);
	assert.deepEqual(asked, [], "handing off doesn't ask while there's no outside text");
	assert.match(runPrompt, /You are Sage/);
	assert.doesNotMatch(runPrompt, /cold climate/);
	assert.equal((await host.harness.snapshot(Jobs, context))?.items.length, 0, "the one-off job is done");
});

test("a chain stops at three hops, and an agent in it can't be asked again; each hop after the first asks the owner", async (t) => {
	// Each receiving agent holds the owner's notes and has another agent's message in its conversation, so its own
	// message on asks; the owner allows each here, to reach the limit.
	const { host, results, childOf, asked } = await start(t, [
		call("message_agent", { agent: "b", text: "pass it on" }),
		call("message_agent", { agent: "dreamwalker", text: "back to you" }),
		call("message_agent", { agent: "c", text: "pass it on" }),
		call("message_agent", { agent: "d", text: "pass it on" }),
		call("message_agent", { agent: "e", text: "pass it on" }),
		say("End of the line."),
		say("D said so."),
		say("C said so."),
		say("B said so."),
	], "once");
	for (const name of ["e", "d", "c", "b"]) {
		const contacts = { b: ["dreamwalker", "c"], c: ["d"], d: ["e"], e: [] }[name] ?? [];
		await host.agents.add({ name, job: `Agent ${name}.`, contacts });
	}
	await host.ask("start a chain");
	const b = await childOf(host.root.id, "message_agent");
	const [backToDreamwalker] = await results(b);
	assert.match(backToDreamwalker!, /dreamwalker is already in this chain \(dreamwalker → b\)/);
	const c = await childOf(b, "message_agent");
	const d = await childOf(c, "message_agent");
	const [toE] = await results(d);
	assert.match(toE!, /This is already 3 agents along \(dreamwalker → b → c → d\); a chain stops at 3/);
	assert.deepEqual(
		asked.map((a) => a.summary.split(":")[0]),
		["message c", "message d"],
	);
});
