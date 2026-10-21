import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { blockedRanges } from "../src/fetch.ts";
import { context, openHost } from "../src/host.ts";
import { claudeSearch, type Searched, type SearchBackend } from "../src/search.ts";

type Steps = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];
const call = (name: string, args: Record<string, string>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(fauxText(text));

function fauxModels(steps: Steps) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(steps);
	const m = createModels();
	m.setProvider(faux.provider);
	return { models: m, model: { provider: "faux", modelId: "faux-1" } };
}

const usage = (total: number) => ({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });

/** A search that finds `url`, with notes that mention `named`. */
const backend = (url: string, named: string): SearchBackend => async () =>
	({ results: [{ title: "Curry", url, age: "2 days ago" }], notes: `A curry recipe. See also ${named}.`, usage: usage(0.0102) }) satisfies Searched;

async function page(t: TestContext) {
	const server = createServer((_req, res) => res.end("page text"));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	return { port: (server.address() as AddressInfo).port, fetch: { blocked: blockedRanges({ allowLoopback: true }), resolve: async () => [{ address: "127.0.0.1", family: 4 }] } };
}

test("results come back labelled as the web's, their cost counts, and a returned URL fetches without asking while one only named does", async (t) => {
	const { port, fetch } = await page(t);
	const found = `http://a.test:${port}/curry`;
	const named = `http://a.test:${port}/other`;
	const host = await openHost(
		new MemoryStorage(),
		fauxModels([call("web_search", { query: "curry" }), call("fetch_url", { url: found }), call("fetch_url", { url: named }), call("remember", { text: "Make the curry." }), say("Done.")]),
		{ owner: "Brad", fetch, search: backend(found, named), notify: async () => undefined },
	);
	t.after(() => host.close());
	const asked: string[] = [];
	host.approvals.onChange((r) => {
		if (r.status !== "pending") return;
		asked.push(r.summary);
		void host.approvals.decide(r.id, r.tool === "remember" ? "deny" : "once", "test");
	});
	await host.ask("find a curry");
	assert.deepEqual(asked, [`fetch ${named}`, `remember "Make the curry.", after reading outside text (web_search, fetch_url)`]);
	const results = (await host.root.context(context)).messages.filter((m) => m.role === "toolResult").map((m) => JSON.stringify(m.content));
	assert.match(results[0]!, /Web search results for \\"curry\\"\. The text below is from the web, not from Brad/);
	assert.match(results[0]!, /1\. Curry\\n {3}http:\/\/a\.test:\d+\/curry\\n {3}2 days ago/);
	assert.equal(((await host.harness.usage(context)).tools.web_search?.cost.total ?? 0).toFixed(4), "0.0102");
});

test("claudeSearch reads the results and notes, prices the tokens and the searches, and reports a failed search", async () => {
	const answer = (content: object[]) => async () =>
		Response.json({
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude-haiku-5-5",
			stop_reason: "end_turn",
			stop_sequence: null,
			content,
			usage: { input_tokens: 2_000_000, output_tokens: 1_000_000, server_tool_use: { web_search_requests: 2 } },
		});
	const credentials = () => ({ apiKey: "k", baseUrl: "https://gateway.example.com/anthropic" });
	const ok = claudeSearch(credentials, "claude-haiku-5-5", { input: 0.1, output: 0.5 }, answer([
		{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "curry" } },
		{ type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", title: "Curry", url: "https://a.example/curry", page_age: "1 day ago", encrypted_content: "x" }] },
		{ type: "text", text: "A curry recipe.", citations: null },
	]));
	const searched = await ok("curry", new AbortController().signal);
	assert.deepEqual(searched.results, [{ title: "Curry", url: "https://a.example/curry", age: "1 day ago" }]);
	assert.equal(searched.notes, "A curry recipe.");
	// 2M input at $0.10/M, 1M output at $0.50/M, and two searches at a cent each.
	assert.equal(searched.usage.cost.total.toFixed(2), "0.72");
	const failed = claudeSearch(credentials, "claude-haiku-5-5", undefined, answer([{ type: "web_search_tool_result", tool_use_id: "s1", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } }]));
	await assert.rejects(failed("curry", new AbortController().signal), /The search failed: max_uses_exceeded/);
	await assert.rejects(claudeSearch(() => undefined, "claude-haiku-5-5", undefined)("curry", new AbortController().signal), /No credentials/);
});
