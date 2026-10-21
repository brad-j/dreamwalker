import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { blockedRanges } from "../src/fetch.ts";
import { context, openHost } from "../src/host.ts";
import { redact } from "../src/redact.ts";
import { call, fauxModels, say, toolResults, workers } from "./helpers.ts";

const SECRET = "nfp_supersecret_value_123";

test("each secret's value becomes its name, the longest first; short values are left alone", () => {
	const secrets = [
		{ name: "SHORT", value: "abc" },
		{ name: "URL", value: "https://ntfy.example.com/topic-secret" },
		{ name: "TOPIC", value: "topic-secret" },
	];
	assert.equal(redact("post to https://ntfy.example.com/topic-secret, or topic-secret, abc", secrets), "post to [redacted URL], or [redacted TOPIC], abc");
});

test("a secret in any tool's result is redacted before it's stored, a worker's and the answer the main agent gets", async (t) => {
	const server = createServer((_req, res) => res.end(`debug: token=${SECRET}`));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const port = (server.address() as AddressInfo).port;
	const host = await openHost(
		new MemoryStorage(),
		fauxModels([call("delegate", { task: "read the debug page" }), call("fetch_url", { url: `http://a.test:${port}/` }), say(`It printed a token: ${SECRET}`), say("Done.")]),
		{
			notify: async () => undefined,
			secrets: () => [{ name: "NETLIFY_AGENT_PAT", value: SECRET }],
			fetch: { blocked: blockedRanges({ allowLoopback: true }), resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
		},
	);
	t.after(() => host.close());
	await host.ask("read it");
	const [worker] = await workers(host.harness, host.root);
	const fetched = toolResults(worker!)[0]!;
	assert.match(fetched, /token=\[redacted NETLIFY_AGENT_PAT\]/);
	const delegated = toolResults((await host.root.context(context)).messages)[0]!;
	assert.match(delegated, /It printed a token: \[redacted NETLIFY_AGENT_PAT\]/);
	assert.ok(![fetched, delegated].some((r) => r.includes(SECRET)));
});
