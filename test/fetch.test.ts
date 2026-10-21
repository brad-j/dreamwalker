import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { createGzip, gzipSync } from "node:zlib";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Situation } from "../src/guards.ts";
import { blockedRanges, createFetch, fetchPublic, type FetchOptions, htmlToText, render } from "../src/fetch.ts";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { context, openHost } from "../src/host.ts";

const PAGE = `<html><head><title>Fish &amp; Chips</title><script>alert("x")</script></head>
<body><nav>Home | About</nav><main><h1>Recipe</h1><p>Batter &mdash; light.</p>
<ul><li>Cod</li><li>Potatoes</li></ul><p>See <a href="/more">the guide</a>.</p>${"<p>filler</p>".repeat(60)}</main>
<footer>© someone</footer></body></html>`;

/** A server on loopback reached as public.test, with loopback allowed; other names point at private ranges. */
async function setup(t: TestContext): Promise<{ base: string; options: FetchOptions }> {
	const server = createServer((req, res) => {
		switch (req.url) {
			case "/page":
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				return res.end(PAGE);
			case "/gzip":
				res.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "gzip" });
				return res.end(gzipSync("compressed hello"));
			case "/to-lan":
				res.writeHead(302, { Location: "http://lan.test/admin" });
				return res.end();
			case "/to-other":
				res.writeHead(302, { Location: `http://other.test:${req.headers.host?.split(":")[1]}/page?q=1` });
				return res.end();
			case "/to-page":
				res.writeHead(301, { Location: "/page" });
				return res.end();
			case "/big":
				res.writeHead(200, { "Content-Type": "text/plain" });
				return res.end("x".repeat(50_000));
			case "/drip": {
				// A byte every 50ms: never quiet long enough for the idle timeout, never done.
				res.writeHead(200, { "Content-Type": "text/plain" });
				const timer = setInterval(() => res.write("x"), 50);
				return res.once("close", () => clearInterval(timer));
			}
			case "/drip-gzip": {
				res.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "gzip" });
				const gzip = createGzip();
				gzip.pipe(res);
				const timer = setInterval(() => {
					gzip.write("x");
					gzip.flush();
				}, 50);
				return res.once("close", () => clearInterval(timer));
			}
			case "/stall":
				res.writeHead(200, { "Content-Type": "text/plain" });
				return res.write("the start");
			case "/stall-gzip": {
				// Some of a compressed page, then silence.
				res.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "gzip" });
				const gzip = createGzip();
				gzip.pipe(res);
				gzip.write("the start");
				return gzip.flush();
			}
			case "/image":
				res.writeHead(200, { "Content-Type": "image/png" });
				return res.end(Buffer.alloc(100));
			default:
				res.writeHead(404, { "Content-Type": "text/plain" });
				return res.end("not here");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const names = new Map(Object.entries({
		"public.test": ["127.0.0.1"],
		"lan.test": ["192.168.0.177"],
		"tailnet.test": ["100.64.0.50"],
		"mixed.test": ["127.0.0.1", "10.0.0.5"],
		"ula.test": ["fd7a:115c:a1e0::1"],
	}));
	const options: FetchOptions = {
		blocked: blockedRanges({ allowLoopback: true }),
		resolve: async (host) => (names.get(host) ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
		maxBytes: 10_000,
	};
	return { base: `http://public.test:${(server.address() as AddressInfo).port}`, options };
}

test("private, LAN, tailnet and loopback addresses are refused, by name, literal or redirect", async (t) => {
	const { base, options } = await setup(t);
	const port = new URL(base).port;
	const refused = (url: string, pattern: RegExp, opts = options) => assert.rejects(fetchPublic(url, opts), pattern);
	await refused(`http://lan.test:${port}/`, /192\.168\.0\.177, a private or reserved address/);
	await refused(`http://tailnet.test:${port}/`, /100\.64\.0\.50/);
	await refused(`http://mixed.test:${port}/`, /10\.0\.0\.5/);
	await refused(`http://ula.test:${port}/`, /fd7a/);
	await refused("http://10.0.0.1/", /private or reserved/);
	await refused("http://[::ffff:192.168.1.1]/", /private or reserved/);
	await refused("file:///etc/passwd", /Only http and https/);
	await refused(`http://user:pass@public.test:${port}/`, /credentials/);
	// Without the test's exception, loopback is refused too.
	await refused(`http://127.0.0.1:${port}/page`, /private or reserved/, { ...options, blocked: blockedRanges() });
});

test("IPv6 forms that carry an IPv4 address are refused: IPv4-compatible (::/96) and 6to4 (2002::/16)", () => {
	const blocked = blockedRanges();
	// ::127.0.0.1 and ::192.168.1.1, and 6to4 for 192.168.1.1 and for a public address, which a relay would carry anywhere.
	for (const address of ["::7f00:1", "::c0a8:101", "2002:c0a8:101::1", "2002:808:808::1"]) assert.ok(blocked.check(address, "ipv6"), address);
	assert.ok(!blocked.check("2606:4700:4700::1111", "ipv6"), "a public IPv6 address");
});

test("a redirect is followed on its host only; one to another host comes back unfollowed, so fetching it is checked like any other", async (t) => {
	const { base, options } = await setup(t);
	const port = new URL(base).port;
	// other.test resolves to nothing, so connecting to it would fail.
	for (const path of ["/to-other", "/to-lan"]) {
		const fetched = await fetchPublic(`${base}${path}`, options);
		assert.equal(fetched.status, 302);
		assert.equal(fetched.body.length, 0);
		assert.equal(fetched.redirect, path === "/to-other" ? `http://other.test:${port}/page?q=1` : "http://lan.test/admin");
	}
	assert.equal(render(await fetchPublic(`${base}/to-other`, options), 20_000), `${base}/to-other redirects (HTTP 302) to http://other.test:${port}/page?q=1, on another host. Fetch that URL to follow it.`);
	await assert.rejects(fetchPublic("http://lan.test/admin", options), /lan\.test resolves to 192\.168\.0\.177/);
});

test("a page that goes silent partway is given up on at the idle timeout, compressed or not, saying so", async (t) => {
	const { base, options } = await setup(t);
	for (const path of ["/stall", "/stall-gzip"]) {
		const started = Date.now();
		await assert.rejects(fetchPublic(`${base}${path}`, { ...options, timeoutMs: 300 }), /No answer from public\.test:\d+ in 0\.3s/, path);
		assert.ok(Date.now() - started < 2000, `${path} took ${Date.now() - started}ms`);
	}
});

test("a page that keeps dripping bytes is given up on at the deadline, compressed or not", async (t) => {
	const { base, options } = await setup(t);
	for (const path of ["/drip", "/drip-gzip"]) {
		const started = Date.now();
		await assert.rejects(fetchPublic(`${base}${path}`, { ...options, timeoutMs: 1000, deadlineMs: 400 }), /didn't finish in 0\.4s/, path);
		assert.ok(Date.now() - started < 2000, `${path} took ${Date.now() - started}ms`);
	}
});

test("pages come back as labelled, readable text", async (t) => {
	const { base, options } = await setup(t);
	const fetched = await fetchPublic(`${base}/to-page`, options);
	assert.equal(fetched.url, `${base}/page`);
	const text = render(fetched, 20_000);
	assert.match(text, /^Fetched http:\/\/public\.test:\d+\/page \(HTTP 200, text\/html\)\./);
	assert.match(text, /not from the user/);
	assert.match(text, /# Fish & Chips/);
	assert.match(text, /# Recipe\n\nBatter - light\./);
	assert.match(text, /- Cod\n- Potatoes/);
	assert.match(text, new RegExp(`See the guide \\(${base}/more\\)\\.`));
	assert.doesNotMatch(text, /alert|Home \| About|someone/);

	assert.match(render(await fetchPublic(`${base}/gzip`, options), 20_000), /compressed hello/);
	const big = await fetchPublic(`${base}/big`, options);
	assert.equal(big.truncated, true);
	assert.equal(big.body.length, 10_000);
	assert.match(render(big, 5_000), /stopped at the size limit; cut to the first 5000 characters/);
	assert.match(render(await fetchPublic(`${base}/image`, options), 20_000), /is image\/png \(100 bytes\), not text/);
});

test("htmlToText keeps the whole page when it marks no main content", () => {
	const text = htmlToText("<body><nav>menu</nav><p>Only &#x26; this&#33;</p></body>", "https://example.com/");
	assert.equal(text, "Only & this!");
});

test("the agent can call fetch_url, and an error status is an error result", async (t) => {
	const { base, options } = await setup(t);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("fetch_url", { url: `${base}/page` }), fauxToolCall("fetch_url", { url: `${base}/missing` })], { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("Read it.")),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await openHost(new MemoryStorage(), { models, model: { provider: "faux", modelId: "faux-1" } }, { fetch: options, notify: async () => undefined });
	t.after(() => host.close());
	// New hosts need approval (test/approvals.test.ts); say yes to each.
	host.approvals.onChange((r) => void (r.status === "pending" && host.approvals.decide(r.id, "once", "test")));
	assert.equal((await (await host.root.submit({ type: "input", content: "read the recipe" }, context)).wait(context)).status, "done");
	const results = (await host.root.context(context)).messages.filter((m) => m.role === "toolResult");
	assert.match(JSON.stringify(results[0]), /Batter - light/);
	assert.equal((results[1] as { isError?: boolean }).isError, true);
});

test("htmlToText leaves an entity it doesn't know as it is, even one named like an object's property", () => {
	assert.equal(htmlToText("<p>&constructor; &toString; &bogus; &AMP;</p>", "https://example.com/"), "&constructor; &toString; &bogus; &");
});

test("a fetch doesn't ask, whatever its host, and what it returns is outside text", async () => {
	const [guard] = createFetch().guards;
	const ask = (url: unknown) => {
		const situation: Situation = { conversationId: 1, callId: "c1", outside: async () => ["fetch_url"], snapshot: async () => undefined };
		return guard!.ask({ url } as never, situation);
	};
	assert.equal(guard!.tool, "fetch_url");
	assert.equal(guard!.outside, true);
	for (const url of ["https://a.example/page", "https://b.example/?q=notes", "not a url"]) assert.equal(await ask(url), undefined, url);
});
