import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createApi } from "../src/api.ts";
import { envFrom } from "../src/environment.ts";
import { context } from "../src/host.ts";
import { conversationId } from "../src/ids.ts";
import { startInstance } from "../src/instance.ts";
import { Jobs } from "../src/jobs.ts";
import { Credentials } from "../src/model.ts";
import { netlifySettingsFrom } from "../src/netlify.ts";
import { call, fauxModels, say, type Steps, system, toolResults, until } from "./helpers.ts";

const TEAM = "team-0001";
const TOKEN = "nfp_test_token_never_shown";
const SECRETS = ["hunter2", "build_hooks/abc", "s3cret-value", "skew-token", "billing@example.com", TOKEN];

const site = (id: string, account: string) => ({
	id,
	name: id,
	ssl_url: `https://${id}.example.com`,
	account_id: account,
	password: "hunter2",
	deploy_hook: "https://api.example.com/build_hooks/abc",
	build_settings: { repo_url: "https://github.com/example/site", repo_branch: "main", cmd: "npm run build", dir: "dist", env: { API_KEY: "s3cret-value" } },
	published_deploy: { id: "d1", state: "ready", published_at: "2026-10-20T10:00:00Z" },
});

/** A fake Netlify API: the token reaches `accounts`; it records each call's path and token. */
function fakeNetlify(accounts: { id: string; slug: string; name: string }[]) {
	const calls: { path: string; token: string | null }[] = [];
	const routes = new Map<string, object>(Object.entries({
		"/accounts": accounts.map((a) => ({ ...a, billing_email: "billing@example.com" })),
		"/test-team/sites": [site("garden", TEAM)],
		"/sites/garden": site("garden", TEAM),
		"/sites/work": site("work", "someone-else"),
		"/sites/garden/deploys": [{ id: "d1", site_id: "garden", state: "ready", context: "production", branch: "main", commit_ref: "abc123", title: "Fix the header", skew_protection_token: "skew-token" }],
		"/deploys/d1": { id: "d1", site_id: "garden", state: "ready", skew_protection_token: "skew-token" },
		"/deploys/d2": { id: "d2", site_id: "work", state: "ready" },
		[`/accounts/${TEAM}/env`]: [{ key: "API_KEY", is_secret: true, scopes: ["functions"], values: [{ value: "s3cret-value", context: "production" }] }],
		"/dns_zones": [{ id: "z1", name: "example.com", account_id: TEAM, dns_servers: ["dns1.example.net"] }],
		"/dns_zones/z1": { id: "z1", name: "example.com", account_id: TEAM },
		"/dns_zones/z1/dns_records": [{ hostname: "www.example.com", type: "CNAME", value: "garden.example.com", ttl: 3600 }],
	}));
	const fetch = async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const path = url.pathname.replace(/^\/api\/v1/, "");
		calls.push({ path, token: new Headers(init?.headers).get("authorization") });
		const body = routes.get(path);
		return body === undefined ? new Response("not found", { status: 404 }) : Response.json(body);
	};
	return { fetch: fetch as typeof globalThis.fetch, calls };
}

const ours = [{ id: TEAM, slug: "test-team", name: "Test team" }];

async function start(t: TestContext, steps: Steps, accounts = ours) {
	const fake = fakeNetlify(accounts);
	const instance = startInstance(async () => new MemoryStorage(), fauxModels(steps), { owner: "the owner", notify: async () => undefined, netlify: { settings: { token: TOKEN, team: TEAM }, fetch: fake.fetch } });
	t.after(() => instance.close());
	const api = createApi(instance, { token: "t", local: false, env: envFrom({}), see: () => undefined, credentials: new Credentials(), describe: () => ({}) });
	const headers = { authorization: "Bearer t", "content-type": "application/json" };
	const post = (path: string, body: object) => api(new Request(`http://dreamwalker.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
	const get = async (path: string) => (await api(new Request(`http://dreamwalker.test${path}`, { headers }))).json();
	const host = (await instance.host())!;
	const asked: string[] = [];
	host.approvals.onChange((r) => {
		if (r.status !== "pending") return;
		asked.push(r.summary);
		void host.approvals.decide(r.id, r.tool === "schedule_job" ? "once" : "deny", "test");
	});
	const results = async (agent: string) => {
		const id = agent === "dreamwalker" ? host.root.id : (await host.agents.list()).find((a) => a.id === agent)!.conversationId;
		return toolResults((await (await host.harness.conversation(conversationId(id), context))!.context(context)).messages);
	};
	return { host, post, get, asked, fake, results };
}

const ntl = { name: "agentNTL", job: "Looks after the owner's Netlify sites.", grants: ["netlify"], sharedNotes: false };

test("the settings come from the environment, and are unset without both", () => {
	assert.deepEqual(netlifySettingsFrom({ NETLIFY_AGENT_PAT: " t ", NETLIFY_AGENT_TEAM: "x" }), { token: "t", team: "x" });
	assert.equal(netlifySettingsFrom({ NETLIFY_AGENT_PAT: "t" }), undefined);
});

test("a granted agent reads sites, deploys, variables' names and DNS, with the token sent and nothing secret coming back", async (t) => {
	const { post, results, fake } = await start(t, [
		call("netlify_sites", {}),
		call("netlify_site", { site: "garden" }),
		call("netlify_deploys", { site: "garden" }),
		call("netlify_deploy", { deploy: "d1" }),
		call("netlify_env_names", { site: "garden" }),
		call("netlify_dns", {}),
		call("netlify_dns", { zone: "z1" }),
		say("Looked."),
	]);
	assert.equal((await post("/api/agents/add", ntl)).status, 201);
	await post("/api/ask", { message: "how are my sites?", agent: "agentntl" });
	const read = await results("agentntl");
	assert.equal(read.length, 7);
	const all = read.join("\n");
	for (const secret of SECRETS) assert.ok(!all.includes(secret), `${secret} came back`);
	assert.match(read[0]!, /garden[^]*https:\/\/github.com\/example\/site/);
	assert.match(read[1]!, /npm run build/);
	assert.match(read[2]!, /Fix the header/);
	assert.match(read[4]!, /API_KEY[^]*production/);
	assert.match(read[6]!, /www\.example\.com[^]*CNAME/);
	assert.ok(fake.calls.every((c) => c.token === `Bearer ${TOKEN}`));
});

test("a token that reaches any other team is refused before anything else is asked of Netlify", async (t) => {
	for (const accounts of [[...ours, { id: "team-work", slug: "work", name: "Work team" }], [{ id: "team-work", slug: "work", name: "Work team" }]]) {
		await t.test(accounts.map((a) => a.name).join(" + "), async (t) => {
			const { post, results, fake, get } = await start(t, [call("netlify_sites", {}), say("Couldn't.")], accounts);
			await post("/api/agents/add", ntl);
			await post("/api/ask", { message: "list my sites", agent: "agentntl" });
			assert.match((await results("agentntl"))[0]!, /Refusing: the token must reach only the configured team, and it reaches [^]*Work team \(team-work\)/);
			assert.deepEqual(
				fake.calls.map((c) => c.path),
				["/accounts"],
			);
			assert.match((await get("/api/netlify/check")).error, /Refusing/);
		});
	}
});

test("a site, deploy or DNS zone of another team is refused", async (t) => {
	const { post, results } = await start(t, [call("netlify_site", { site: "work" }), call("netlify_deploy", { deploy: "d2" }), say("No.")]);
	await post("/api/agents/add", ntl);
	await post("/api/ask", { message: "look at work", agent: "agentntl" });
	const [siteResult, deployResult] = await results("agentntl");
	assert.match(siteResult!, /work isn't one of the team's sites/);
	assert.match(deployResult!, /work isn't one of the team's sites/);
});

test("only an agent granted netlify has its tools, and its job runs do; dreamwalker, other agents and workers don't", async (t) => {
	const at = new Date(Date.now() + 300).toISOString();
	let runPrompt = "";
	const { host, post, get, asked } = await start(t, [
		call("schedule_job", { title: "Deploy check", instruction: "Check the deploys.", at }),
		say("Scheduled."),
		(ctx) => {
			runPrompt = system(ctx);
			return say("All deployed.");
		},
	]);
	await post("/api/agents/add", ntl);
	await post("/api/agents/add", { name: "Sage", job: "Garden questions." });
	assert.equal((await post("/api/agents/add", { name: "Other", job: "x", grants: ["github"] })).status, 400);
	const tools = async (id: number) => (await (await host.harness.conversation(conversationId(id), context))!.agent(context)).tools.map((tool) => tool.name);
	const roster = await host.agents.list();
	assert.ok((await tools(roster.find((a) => a.id === "agentntl")!.conversationId)).includes("netlify_sites"));
	assert.ok(!(await tools(roster.find((a) => a.id === "sage")!.conversationId)).includes("netlify_sites"));
	assert.ok(!(await tools(host.root.id)).includes("netlify_sites"));
	assert.deepEqual((await get("/api/agents")).grants, ["netlify"]);

	await post("/api/ask", { message: "check deploys soon", agent: "agentntl" });
	assert.match(asked[0]!, /^schedule "Deploy check"/);
	await until(async () => ((await host.harness.snapshot(Jobs, context))?.items.length === 0 ? true : undefined));
	assert.match(runPrompt, /"name":"netlify_sites"/);
	assert.doesNotMatch(runPrompt, /"name":"remember"/, "a run has none of the owner's notes");

	// Taking the grant away takes the tools away.
	await post("/api/agents/update", { id: "agentntl", grants: [] });
	assert.ok(!(await tools(roster.find((a) => a.id === "agentntl")!.conversationId)).includes("netlify_sites"));
});

test("what Netlify answers is outside text, so writing a note afterwards asks", async (t) => {
	const { post, asked } = await start(t, [call("netlify_sites", {}), call("remember", { text: "The garden site deploys from main." }), say("Done.")]);
	await post("/api/agents/add", { ...ntl, sharedNotes: true });
	await post("/api/ask", { message: "remember how garden deploys", agent: "agentntl" });
	assert.deepEqual(asked, [`remember "The garden site deploys from main.", after reading outside text (netlify_sites)`]);
});

test("the check says which team the token reaches, by slug, or that the tools aren't set up", async (t) => {
	const { get } = await start(t, []);
	assert.deepEqual(await get("/api/netlify/check"), { configured: true, team: "test-team" });
	const bare = startInstance(async () => new MemoryStorage(), fauxModels([]), { notify: async () => undefined });
	t.after(() => bare.close());
	const api = createApi(bare, { token: "t", local: false, env: envFrom({}), see: () => undefined, credentials: new Credentials(), describe: () => ({}) });
	assert.deepEqual(await (await api(new Request("http://dreamwalker.test/api/netlify/check", { headers: { authorization: "Bearer t" } }))).json(), { configured: false });
});
