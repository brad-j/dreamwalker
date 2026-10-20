import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createApi } from "../src/api.ts";
import { Budget, budgetSettingsFrom, type Limits } from "../src/budget.ts";
import { envFrom } from "../src/environment.ts";
import { context, openHost } from "../src/host.ts";
import { startInstance } from "../src/instance.ts";
import { Credentials } from "../src/model.ts";

const fauxModels = () => {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage(fauxText("ok"))));
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
};

/** dreamwalker whose spend total is `spent.value`, with what it tells the owner collected. */
async function start(t: TestContext, limits: Limits = { daily: 5, monthly: 0 }) {
	const spent = { value: 0 };
	const told: string[] = [];
	const host = await openHost(new MemoryStorage(), fauxModels(), {
		budget: { limits, timeZone: "UTC" },
		notify: async (text) => void told.push(text),
		spend: async () => spent.value,
	});
	t.after(() => host.close());
	const ask = async () => (await host.root.submit({ type: "input", content: "hi" }, context)).wait(context);
	return { host, spent, told, ask };
}

const wait = () => new Promise((r) => setTimeout(r, 50));

test("requests stop at the daily limit, say why, and tell the owner once", async (t) => {
	const { host, spent, told, ask } = await start(t);
	assert.equal((await ask()).status, "done");

	spent.value = 4.1;
	await host.budget.refresh();
	await wait();
	assert.equal(told.length, 1);
	assert.match(told[0]!, /spent \$4\.10 today, 80% of the daily limit of \$5\.00/);
	assert.equal((await ask()).status, "done", "80% still answers");

	spent.value = 5.2;
	await host.budget.refresh();
	await wait();
	const refused = await host.ask("hi");
	assert.deepEqual(refused, { ok: false, reason: "Today's spend is $5.20, at the daily limit of $5.00." });
	assert.equal(told.length, 2);
	assert.match(told[1]!, /stopped making model requests.*starts again tomorrow/);
	await ask();
	await host.budget.refresh();
	await wait();
	assert.equal(told.length, 2, "told twice about the same stop");
});

test("allowing more lets requests through until the new limit", async (t) => {
	const { host, spent, told, ask } = await start(t);
	spent.value = 6;
	await host.budget.refresh();
	assert.equal((await ask()).status, "unanswered");
	const status = await host.budget.allowMore(5);
	assert.deepEqual([status.stopped, status.dailyLimit], [false, 10]);
	assert.equal((await ask()).status, "done");
	spent.value = 10.5;
	await host.budget.refresh();
	await wait();
	assert.equal((await ask()).status, "unanswered");
	assert.equal(told.filter((m) => /stopped/.test(m)).length, 2, "the second stop wasn't told");
});

test("a new day starts the count again", async (t) => {
	const { host, spent, ask } = await start(t);
	spent.value = 7;
	await host.budget.refresh();
	assert.equal((await ask()).status, "unanswered");
	// As if the stop happened yesterday: the next read moves the baseline to today.
	await host.root.commit(async (tx) => {
		(await tx.doc(Budget)).day = "2000-01-01";
	}, context);
	const status = await host.budget.refresh();
	assert.deepEqual([status.today, status.stopped], [0, false]);
	assert.equal((await ask()).status, "done");
});

test("the monthly limit holds across days", async (t) => {
	const { host, spent, told, ask } = await start(t, { daily: 0, monthly: 20 });
	spent.value = 21;
	await host.budget.refresh();
	await wait();
	assert.equal((await ask()).status, "unanswered");
	assert.match(told.at(-1)!, /monthly limit of \$20\.00.*next month/);
	await host.root.commit(async (tx) => {
		(await tx.doc(Budget)).day = "2000-01-01";
	}, context);
	assert.equal((await host.budget.refresh()).stopped, true);
});

test("the API shows the budget and allows more", async (t) => {
	const spent = { value: 0 };
	const instance = startInstance(async () => new MemoryStorage(), fauxModels(), { budget: { limits: { daily: 5, monthly: 0 }, timeZone: "UTC" }, notify: async () => undefined, spend: async () => spent.value });
	t.after(() => instance.close());
	const credentials = new Credentials();
	const api = createApi(instance, { token: "owner-token", local: false, env: envFrom({}), see: () => undefined, credentials, describe: () => ({}) });
	const headers = { authorization: "Bearer owner-token", "content-type": "application/json" };
	// The day's count starts from the total when the guard first looks, here $0.
	await instance.host();
	spent.value = 5.5;
	const shown = await (await api(new Request("http://dreamwalker.test/api/budget", { headers }))).json();
	assert.deepEqual([shown.today, shown.stopped], [5.5, true]);
	const allow = (body: string) => api(new Request("http://dreamwalker.test/api/budget/allow", { method: "POST", headers, body }));
	assert.equal((await allow(JSON.stringify({ amount: -1 }))).status, 400);
	assert.equal((await api(new Request("http://dreamwalker.test/api/budget/allow", { method: "POST", body: "{}" }))).status, 401);
	const allowed = await (await allow("{}")).json();
	assert.deepEqual([allowed.dailyLimit, allowed.stopped], [10, false]);
	const status = await (await api(new Request("http://dreamwalker.test/api/status", { headers }))).json();
	assert.equal(status.budget.dailyLimit, 10);
});

test("budget settings come from the environment and are checked", () => {
	assert.deepEqual(budgetSettingsFrom({}), { limits: { daily: 5, monthly: 50 }, timeZone: "UTC" });
	assert.deepEqual(budgetSettingsFrom({ DREAMWALKER_BUDGET_DAILY: "2.5", DREAMWALKER_BUDGET_MONTHLY: "0", DREAMWALKER_TZ: "America/New_York" }), { limits: { daily: 2.5, monthly: 0 }, timeZone: "America/New_York" });
	assert.throws(() => budgetSettingsFrom({ DREAMWALKER_BUDGET_DAILY: "-1" }), /DREAMWALKER_BUDGET_DAILY must be a dollar amount/);
	assert.throws(() => budgetSettingsFrom({ DREAMWALKER_BUDGET_MONTHLY: "lots" }), /DREAMWALKER_BUDGET_MONTHLY/);
	assert.throws(() => budgetSettingsFrom({ DREAMWALKER_TZ: "Mars/Olympus" }), RangeError);
});

test("a refresh still running at shutdown ends with the last status instead of an error", async () => {
	// Slow enough that the Harness closes while the refresh waits for the total.
	const spend = async () => new Promise<number>((resolve) => setTimeout(() => resolve(1), 100));
	const host = await openHost(new MemoryStorage(), fauxModels(), { spend, notify: async () => undefined });
	const before = host.budget.status();
	const pending = host.budget.refresh();
	await host.close();
	assert.deepEqual(await pending, before);
});
