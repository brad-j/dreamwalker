import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { type ApiOptions, createApi } from "../src/api.ts";
import { context } from "../src/host.ts";
import { startInstance } from "../src/instance.ts";
import { envFrom } from "../src/environment.ts";
import { Credentials, modelFor } from "../src/model.ts";

const instance = startInstance(async () => new MemoryStorage(), modelFor({ provider: "faux" }));
const host = (await instance.host())!;
after(() => instance.close());

const options = (overrides: Partial<ApiOptions> = {}): ApiOptions => {
	const credentials = overrides.credentials ?? new Credentials();
	return { token: "owner-token", local: false, credentials, env: envFrom({}), see: (read) => credentials.see(read), describe: () => ({ storageKind: "memory" }), ...overrides };
};
const api = createApi(instance, options());
const owner = { authorization: "Bearer owner-token", "content-type": "application/json" };
const ask = (body: string, headers: Record<string, string> = owner) => api(new Request("http://dreamwalker.test/api/ask", { method: "POST", body, headers }));

test("a message is answered by the model", async () => {
	const response = await ask(JSON.stringify({ message: "hello" }));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { answer: 'You said: "hello"' });
});

test("the same request id finds the same run instead of asking twice", async () => {
	const first = await (await ask(JSON.stringify({ message: "once", requestId: "r-1" }))).json();
	const again = await (await ask(JSON.stringify({ message: "once", requestId: "r-1" }))).json();
	assert.deepEqual(again, first);
	const view = await host.root.viewState(context);
	const asked = view.value.entries.filter((e) => e.kind === "dreamwalker.owner" && JSON.stringify(e.model).includes("once"));
	view.dispose();
	assert.equal(asked.length, 1);
});

test("a body without a message is refused", async () => {
	const response = await ask(JSON.stringify({ text: "hello" }));
	assert.equal(response.status, 400);
	assert.match((await response.json()).error, /message should be a string/);
});

test("asking needs the owner's token", async () => {
	assert.equal((await ask(JSON.stringify({ message: "hi" }), { "content-type": "application/json" })).status, 401);
	assert.equal((await ask(JSON.stringify({ message: "hi" }), { authorization: "Bearer wrong", "content-type": "application/json" })).status, 401);
});

test("without a token set, guarded routes are refused except under netlify dev", async () => {
	const status = (o: ApiOptions) => createApi(instance, o)(new Request("http://dreamwalker.test/api/status"));
	assert.equal((await status(options({ token: undefined }))).status, 401);
	assert.equal((await status(options({ token: undefined, local: true }))).status, 200);
});

test("health and wake need no token", async () => {
	assert.equal((await api(new Request("http://dreamwalker.test/api/health"))).status, 200);
	assert.deepEqual(await (await api(new Request("http://dreamwalker.test/api/wake"))).json(), { awake: true });
});

test("an earlier production deploy refuses everything but health, waking included; the published one and previews run", async () => {
	const at = (deploy: ApiOptions["deploy"]) => createApi(instance, options({ deploy }));
	const old = at(() => ({ id: "0001", context: "production", published: false }));
	assert.equal((await old(new Request("http://dreamwalker.test/api/health"))).status, 200);
	for (const path of ["/api/wake", "/api/status", "/api/approvals"]) assert.equal((await old(new Request(`http://dreamwalker.test${path}`, { headers: owner }))).status, 410, path);
	for (const deploy of [{ id: "0002", context: "production", published: true }, { id: "0003", context: "deploy-preview", published: false }]) {
		assert.deepEqual(await (await at(() => deploy)(new Request("http://dreamwalker.test/api/wake"))).json(), { awake: true }, deploy.context);
	}
});

test("status describes the instance and the model's credentials, never the key", async () => {
	const credentials = new Credentials();
	const env = { ANTHROPIC_API_KEY: "secret-gateway-key", ANTHROPIC_BASE_URL: "https://gateway.example.com/anthropic" };
	const response = await createApi(instance, options({ credentials, env: envFrom(env) }))(new Request("http://dreamwalker.test/api/status", { headers: owner }));
	const text = await response.text();
	assert.doesNotMatch(text, /secret-gateway-key/);
	const status = JSON.parse(text);
	assert.equal(status.storageKind, "memory");
	assert.equal(status.storage, "open");
	assert.deepEqual(status.model, { credentials: "the AI Gateway", baseHost: "gateway.example.com", ageSeconds: 0 });
});

test("unknown paths are not found", async () => {
	assert.equal((await api(new Request("http://dreamwalker.test/api/nope", { headers: owner }))).status, 404);
});

test("the Gateway's credentials are kept for model calls outside a request", () => {
	let now = 1_000;
	const credentials = new Credentials(() => now);
	let read = envFrom({ ANTHROPIC_API_KEY: "gateway-key", ANTHROPIC_BASE_URL: "https://gateway.example.com/anthropic" });
	const chosen = modelFor({ provider: "anthropic", id: "claude-haiku-5-5" }, credentials, (name) => read(name));
	assert.equal(chosen.models.getModel("anthropic", "claude-haiku-5-5")?.baseUrl, "https://gateway.example.com/anthropic");
	// The request ends and the Gateway's variables go with it; the next call still has them.
	read = envFrom({});
	now = 61_000;
	assert.equal(credentials.current(read)?.apiKey, "gateway-key");
	assert.deepEqual(credentials.describe(read), { credentials: "the AI Gateway", baseHost: "gateway.example.com", ageSeconds: 60 });
});

test("a key set on the site goes straight to Anthropic", () => {
	const credentials = new Credentials();
	const chosen = modelFor({ provider: "anthropic", id: "claude-haiku-5-5" }, credentials, envFrom({ ANTHROPIC_API_KEY: "own-key" }));
	assert.equal(chosen.models.getModel("anthropic", "claude-haiku-5-5")?.baseUrl, "https://api.anthropic.com");
	assert.equal(credentials.describe(envFrom({})).credentials, "a key set on the site");
});

test("closing twice closes once", async () => {
	const twice = startInstance(async () => new MemoryStorage(), modelFor({ provider: "faux" }));
	await twice.host();
	await Promise.all([twice.close(), twice.close()]);
	await twice.close();
});

test("an instance that can't open says so, and opens on a later request once it can", async () => {
	let ready = false;
	const later = startInstance(async () => {
		if (!ready) throw new Error("no database yet");
		return new MemoryStorage();
	}, modelFor({ provider: "faux" }));
	const api = createApi(later, options());
	assert.equal((await api(new Request("http://dreamwalker.test/api/wake"))).status, 503);
	const status = await (await api(new Request("http://dreamwalker.test/api/status", { headers: owner }))).json();
	assert.equal(status.storage, "failed: no database yet");
	ready = true;
	assert.deepEqual(await (await api(new Request("http://dreamwalker.test/api/wake"))).json(), { awake: true });
	await later.close();
});
