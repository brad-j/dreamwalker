import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createApi } from "../src/api.ts";
import { envFrom } from "../src/environment.ts";
import { startInstance } from "../src/instance.ts";
import { Credentials } from "../src/model.ts";

function fauxModels(steps: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(steps);
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

test("the transcript has the owner's words without the stamp, tool calls with their results, and answers; reminders list and cancel", async (t) => {
	const instance = startInstance(
		async () => new MemoryStorage(),
		fauxModels([fauxAssistantMessage([fauxText("Setting it."), fauxToolCall("remind", { text: "stretch", inMinutes: 30 })], { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("Done: **30 minutes**."))]),
		{ notify: async () => undefined },
	);
	t.after(() => instance.close());
	const api = createApi(instance, { token: "t", local: false, env: envFrom({}), see: () => undefined, credentials: new Credentials(), describe: () => ({}) });
	const headers = { authorization: "Bearer t", "content-type": "application/json" };
	const get = async (path: string) => (await api(new Request(`http://dreamwalker.test${path}`, { headers }))).json();

	assert.equal((await api(new Request("http://dreamwalker.test/api/ask", { method: "POST", headers, body: JSON.stringify({ message: "remind me to stretch in 30" }) }))).status, 200);
	const { lines } = await get("/api/transcript");
	assert.deepEqual(
		lines.map((l: { kind: string; text?: string; name?: string; error?: boolean }) => [l.kind, l.text ?? l.name, l.error]),
		[
			["you", "remind me to stretch in 30", undefined],
			["tool", "remind", false],
			["answer", "Setting it.", undefined],
			["answer", "Done: **30 minutes**.", undefined],
		],
	);
	assert.match(lines[1].result, /^Reminder \d+ set for .*: stretch$/);
	assert.equal(lines[1].args, JSON.stringify({ text: "stretch", inMinutes: 30 }));

	const { reminders } = await get("/api/reminders");
	assert.deepEqual(reminders.map((r: { text: string }) => r.text), ["stretch"]);
	const cancel = (id: number) => api(new Request("http://dreamwalker.test/api/reminders/cancel", { method: "POST", headers, body: JSON.stringify({ id }) }));
	assert.equal((await cancel(reminders[0].taskId)).status, 200);
	assert.equal((await cancel(reminders[0].taskId)).status, 404);
	assert.deepEqual((await get("/api/reminders")).reminders, []);
});
