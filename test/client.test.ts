import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createApi } from "../src/api.ts";
import { ApiError, clientSettingsFrom, createClient } from "../src/client.ts";
import { envFrom } from "../src/environment.ts";
import { startInstance } from "../src/instance.ts";
import { Credentials, modelFor } from "../src/model.ts";

// The client against the real API handler, with fetch replaced by a direct call.
const instance = startInstance(async () => new MemoryStorage(), modelFor({ provider: "faux" }), { notify: async () => undefined });
after(() => instance.close());
const api = createApi(instance, { token: "owner-token", local: false, env: envFrom({}), see: () => undefined, credentials: new Credentials(), describe: () => ({ storageKind: "memory" }) });
const direct: typeof fetch = async (input, init) => api(new Request(input, init));
const client = createClient({ url: "https://dreamwalker.example.com", token: "owner-token" }, direct);

test("ask returns the answer, and the same id finds the same run", async () => {
	assert.equal(await client.ask("hello"), 'You said: "hello"');
	assert.equal(await client.ask("once", "same"), await client.ask("once", "same"));
});

test("budget, allow, status and wake read the server's answers", async () => {
	const budget = await client.budget();
	assert.deepEqual([budget.today, budget.dailyLimit, budget.stopped], [0, 5, false]);
	assert.equal((await client.allow(2.5)).dailyLimit, 7.5);
	assert.equal(await client.wake(), true);
	assert.match(JSON.stringify(await client.status()), /"storage":"open"/);
});

test("a wrong token says to check it", async () => {
	const wrong = createClient({ url: "https://dreamwalker.example.com", token: "nope" }, direct);
	await assert.rejects(wrong.ask("hi"), (error) => error instanceof ApiError && error.status === 401 && /check DREAMWALKER_TOKEN/.test(error.message));
});

test("a page that isn't JSON, like a login page, is reported as such", async () => {
	const login = createClient({ url: "https://dreamwalker.example.com", token: "t" }, async () => new Response("<!DOCTYPE html><title>Login Redirect</title>", { status: 401 }));
	await assert.rejects(login.status(), /401 from \/api\/status, not JSON: <!DOCTYPE html>/);
});

test("settings come from the environment", () => {
	assert.deepEqual(clientSettingsFrom({ DREAMWALKER_URL: "https://x.example.com", DREAMWALKER_TOKEN: "t" }), { url: "https://x.example.com", token: "t" });
	assert.throws(() => clientSettingsFrom({}), /DREAMWALKER_URL isn't set/);
});
