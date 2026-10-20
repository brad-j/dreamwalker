import assert from "node:assert/strict";
import { test } from "node:test";
import { wake } from "../src/wake.ts";

test("wake requests /api/wake on the site and reports the answer", async () => {
	const asked: string[] = [];
	const result = await wake("https://dreamwalker.example.com", async (url) => {
		asked.push(String(url));
		return Response.json({ awake: true });
	});
	assert.deepEqual(asked, ["https://dreamwalker.example.com/api/wake"]);
	assert.deepEqual([result.ok, result.status], [true, 200]);
});

test("a failed wake is reported, not thrown", async () => {
	const down = await wake("https://dreamwalker.example.com", async () => {
		throw new Error("connection refused");
	});
	assert.deepEqual([down.ok, down.status], [false, 0]);
	const asleep = await wake("https://dreamwalker.example.com", async () => Response.json({ awake: false }, { status: 503 }));
	assert.deepEqual([asleep.ok, asleep.status], [false, 503]);
});
