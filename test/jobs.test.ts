import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { createApi } from "../src/api.ts";
import { envFrom } from "../src/environment.ts";
import type { Situation } from "../src/guards.ts";
import { context, openHost } from "../src/host.ts";
import { startInstance } from "../src/instance.ts";
import { backoff, createJobs, describeSchedule, type Job, JobReported, Jobs, MAX_JOBS, nextRun, NOTHING, parseSchedule, recordReport, type Report, resumeJob } from "../src/jobs.ts";
import { Credentials } from "../src/model.ts";
import type { Adapters } from "../src/notifications.ts";
import { setTimeZone, timeZone } from "../src/time.ts";
import { conversationId } from "../src/ids.ts";
import { type Steps, until } from "./helpers.ts";

/** A way to reach the owner that hands each job report it's sent to `handle`. */
const reporting = (handle: (report: Report) => void): Adapters => ({
	ntfy: {
		send: async (notice) => {
			if (notice.kind === "report" || notice.kind === "paused") handle(notice.report);
			return true;
		},
	},
});

function faux(steps: Steps) {
	const provider = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	provider.setResponses(steps);
	const models = createModels();
	models.setProvider(provider.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

/** dreamwalker with every approval granted and reports collected. */
async function start(t: TestContext, steps: Steps, storage: Storage = new MemoryStorage()) {
	const reports: Report[] = [];
	const host = await openHost(storage, faux(steps), {
		budget: { limits: { daily: 0, monthly: 0 }, timeZone: "America/New_York" },
		adapters: reporting((r) => void reports.push(r)),
		notify: async () => undefined,
	});
	t.after(() => host.close());
	host.approvals.onChange((r) => void (r.status === "pending" && host.approvals.decide(r.id, "once", "test")));
	return { host, reports };
}

/** A job straight into the storage, as schedule_job would make it, with `extra` on top. */
async function addTestJob(host: Awaited<ReturnType<typeof start>>["host"], title: string, extra: Partial<Job> = {}): Promise<number> {
	const job = await host.root.commit((tx) => host.jobs.addJob(tx, host.root.id, { title, instruction: `Run ${title}.`, schedule: { kind: "every", minutes: 360, from: Date.now() + 200 }, mode: "report" }), context);
	await host.root.commit(async (tx) => {
		Object.assign((await tx.doc(Jobs)).items.find((j) => j.taskId === job.taskId)!, extra);
	}, context);
	return job.taskId;
}

const jobNamed = async (host: Awaited<ReturnType<typeof start>>["host"], title: string) => (await host.harness.snapshot(Jobs, context))?.items.find((j) => j.title === title);

test("schedules are parsed and described", () => {
	const now = Date.parse("2026-10-10T12:00:00Z");
	assert.deepEqual(parseSchedule({ every: "6h" }, now), { kind: "every", minutes: 360, from: now + 360 * 60_000 });
	assert.deepEqual(parseSchedule({ time: "8:05", days: "weekdays" }, now), { kind: "daily", time: "08:05", days: [1, 2, 3, 4, 5] });
	assert.deepEqual(parseSchedule({ time: "21:00", days: "Mon, thursday" }, now), { kind: "daily", time: "21:00", days: [1, 4] });
	assert.throws(() => parseSchedule({ every: "1h" }, now), /at most every 6 hours/);
	assert.throws(() => parseSchedule({ at: "2026-10-09T12:00:00Z" }, now), /in the past/);
	assert.throws(() => parseSchedule({ every: "6h", time: "08:00" }, now), /exactly one/);
	assert.throws(() => parseSchedule({ time: "25:00" }, now), /HH:MM/);
	assert.throws(() => parseSchedule({ time: "08:00", days: "someday" }, now), /Unknown day/);
	assert.equal(describeSchedule({ kind: "daily", time: "08:00", days: [1, 2, 3, 4, 5] }), "at 08:00, weekdays");
	assert.equal(describeSchedule({ kind: "every", minutes: 1440, from: 0 }), "every 1 day(s)");
});

test("the next run follows the time zone, weekdays and DST", (t) => {
	const zone = timeZone();
	t.after(() => setTimeZone(zone));
	setTimeZone("America/New_York");
	const weekdays = { kind: "daily" as const, time: "08:00", days: [1, 2, 3, 4, 5] };
	// Saturday 2026-10-10, noon New York time: next is Monday 08:00 EDT.
	assert.equal(new Date(nextRun(weekdays, Date.parse("2026-10-10T16:00:00Z"))!).toISOString(), "2026-10-12T12:00:00.000Z");
	assert.equal(new Date(nextRun(weekdays, Date.parse("2026-10-12T11:59:00Z"))!).toISOString(), "2026-10-12T12:00:00.000Z");
	// Across the end of DST (2026-11-01): 08:00 EST is 13:00 UTC.
	assert.equal(new Date(nextRun({ kind: "daily", time: "08:00", days: [0, 1, 2, 3, 4, 5, 6] }, Date.parse("2026-11-01T00:00:00Z"))!).toISOString(), "2026-11-01T13:00:00.000Z");
	const every = { kind: "every" as const, minutes: 360, from: 1_000_000 };
	assert.equal(nextRun(every, 0), 1_000_000);
	assert.equal(nextRun(every, 1_000_000), 1_000_000 + 360 * 60_000);
	assert.equal(nextRun({ kind: "once", at: 5 }, 5), undefined);
});

test("a job asks first, runs in its own conversation, reports, and is recorded where it was made", async (t) => {
	const at = new Date(Date.now() + 400).toISOString();
	const { host, reports } = await start(t, [
		fauxAssistantMessage(fauxToolCall("schedule_job", { title: "Oven", instruction: "Say the oven is off.", at }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("Scheduled.")),
		(ctx) => {
			// The run sees only its own prompt, not the conversation that made the job.
			const users = ctx.messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content));
			return fauxAssistantMessage(fauxText(users.length === 1 && /Scheduled job \\"Oven\\"/.test(users[0]!) && !/check later/.test(users[0]!) ? "The oven is off." : `wrong context: ${users.join(" | ")}`));
		},
	]);
	let asked = "";
	host.approvals.onChange((r) => void (r.status === "pending" && (asked = r.summary)));
	await host.ask("check later");
	assert.match(asked, /^schedule "Oven", once, at .*: Say the oven is off\.$/);
	assert.equal((await host.harness.snapshot(Jobs, context))?.items.length, 1);

	const [report] = await until(() => (reports.length > 0 ? reports : undefined));
	assert.deepEqual([report!.title, report!.text], ["Oven", "The oven is off."]);
	assert.notEqual(report!.conversationId, host.root.id);
	const entries = await until(async () => {
		const page = await host.root.commit((tx) => tx.scanEntries({ conversationId: host.root.id }, 100), context);
		const found = page.items.filter((e) => JobReported.is(e));
		return found.length > 0 ? found : undefined;
	});
	assert.equal(entries[0]!.data.delivered, true);
	// A one-off job is gone once it's run, and its run couldn't schedule jobs of its own.
	await until(async () => ((await host.harness.snapshot(Jobs, context))?.items.length === 0 ? true : undefined));
	const runTools = (await (await host.harness.conversation(conversationId(report!.conversationId), context))!.agent(context)).tools.map((tool) => tool.name);
	assert.ok(!runTools.includes("schedule_job"));
	assert.ok(runTools.includes("delegate") && !runTools.includes("fetch_url"), "a run hands web work to a worker like the main agent");
});

test("a watch with nothing to report stays quiet, and its runs see its earlier reports and the quiet runs since", async (t) => {
	let seen = "";
	const { host, reports } = await start(t, [
		(ctx) => {
			seen = JSON.stringify(ctx.messages.filter((m) => m.role === "user"));
			return fauxAssistantMessage(fauxText(NOTHING));
		},
	]);
	await addTestJob(host, "Backups", { mode: "watch", recent: [{ at: Date.parse("2026-10-19T12:00:00Z"), text: "The backup failed." }], quietRuns: 2 });
	const job = await until(async () => {
		const j = await jobNamed(host, "Backups");
		return j?.lastResult === "quiet" ? j : undefined;
	});
	assert.match(seen, /Your last report for this job, oldest first/);
	assert.match(seen, /The backup failed\./);
	assert.match(seen, /Since the last one, 2 runs had nothing to report\./);
	assert.match(seen, /This is a watch: only report if something needs/);
	assert.match(seen, /Don't report again what your earlier reports already covered unless it has got worse/);
	assert.equal(job.quietRuns, 3);
	assert.deepEqual(reports, [], "a quiet run tells the owner nothing");
	const page = await host.root.commit((tx) => tx.scanEntries({ conversationId: host.root.id }, 100), context);
	assert.equal(page.items.filter((e) => JobReported.is(e)).length, 0, "and leaves no report in the conversation");
});

test("failures wait longer each time, tell the owner once, and pause the job after five in a row", async (t) => {
	assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => backoff(n) / 60_000), [15, 30, 60, 120, 240, 240]);
	const answer: Steps[number] = (ctx) => (/Healthy/.test(JSON.stringify(ctx.messages)) ? fauxAssistantMessage(fauxText("All good.")) : fauxAssistantMessage("", { stopReason: "error", errorMessage: "model down" }));
	const { host, reports } = await start(t, Array<Steps[number]>(20).fill(answer));
	const started = Date.now();
	await addTestJob(host, "First");
	await addTestJob(host, "Second", { failures: 1 });
	await addTestJob(host, "Fifth", { failures: 4 });
	await addTestJob(host, "Healthy", { failures: 3 });
	const [first, second, fifth, healthy] = await until(async () => {
		const jobs = await Promise.all(["First", "Second", "Fifth", "Healthy"].map((title) => jobNamed(host, title)));
		return jobs.every((j) => j?.lastAt !== undefined) ? (jobs as Job[]) : undefined;
	});
	assert.equal(first!.failures, 1);
	assert.ok(first!.nextAt! >= started + backoff(1), "the next run waits 15 minutes");
	assert.equal(second!.failures, 2);
	assert.equal(fifth!.paused?.reason, "5 failed runs in a row");
	assert.equal(healthy!.failures, 0);
	assert.equal(healthy!.lastResult, "reported");
	const told = reports.filter((r) => r.title !== "Healthy").map((r) => [r.title, r.paused ?? false]);
	assert.deepEqual(told.sort(), [["Fifth", true], ["First", false]]);
	assert.match(reports.find((r) => r.title === "Fifth")!.text, /^Paused after 5 failed runs in a row; .*The last one: The run didn't finish/);
});

test("a paused job skips its runs until it's resumed", async (t) => {
	const { host, reports } = await start(t, Array.from({ length: 10 }, () => fauxAssistantMessage(fauxText("Ran."))));
	const id = await addTestJob(host, "Held", { paused: { at: Date.now(), reason: "paused by the owner" }, failures: 5 });
	await addTestJob(host, "Once", { paused: { at: Date.now(), reason: "paused by the owner" }, schedule: { kind: "once", at: Date.now() + 200 } });
	const firstAt = (await jobNamed(host, "Held"))!.nextAt!;
	await until(async () => ((await jobNamed(host, "Held"))!.nextAt! > firstAt + 1000 && (await jobNamed(host, "Once")) === undefined ? true : undefined));
	assert.equal(reports.length, 0);
	const resumed = await host.root.commit((tx) => resumeJob(tx, id), context);
	assert.equal(resumed?.failures, 0);
	assert.equal(await host.root.commit((tx) => resumeJob(tx, id), context), undefined, "it isn't paused any more");
});

test("a job that runs too often or has no room is refused before asking", async (t) => {
	const { host } = await start(t, [
		fauxAssistantMessage(fauxToolCall("schedule_job", { title: "Often", instruction: "x", every: "1h" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("schedule_job", { title: "One more", instruction: "x", every: "6h" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("ok")),
	]);
	for (let i = 0; i < MAX_JOBS; i += 1) await addTestJob(host, `Job ${i}`, { schedule: { kind: "every", minutes: 1440, from: Date.now() + 86_400_000 } });
	const asked: string[] = [];
	host.approvals.onChange((r) => void (r.status === "pending" && asked.push(r.summary)));
	await host.ask("check often");
	const results = (await host.root.context(context)).messages.flatMap((m) => (m.role === "toolResult" ? [JSON.stringify(m.content)] : []));
	assert.match(results[0]!, /at most every 6 hours/);
	assert.match(results[1]!, new RegExp(`There are already ${MAX_JOBS} jobs`));
	assert.deepEqual(asked, []);
});

test("every new job asks, showing the whole instruction, and cancelling asks after outside text", async () => {
	const { guards } = createJobs({ deliver: async () => undefined, owner: "the owner" });
	const situation = (outside: string[]): Situation => ({ conversationId: 1, callId: "c1", outside: async () => outside, outsideThisTurn: async () => [], snapshot: async () => ({ items: [{ taskId: 7, title: "Backups" }] }) as never });
	const schedule = guards.find((g) => g.tool === "schedule_job")!;
	const long = "y".repeat(2000);
	const asked = await schedule.ask({ title: "Briefing", instruction: long, time: "08:00", days: "weekdays", mode: "watch" }, situation([]));
	assert.match(asked!.summary, /^schedule "Briefing", at 08:00, weekdays \(a watch\): y+… \(2000 characters\)$/);
	assert.equal(asked!.detail, long);
	const cancel = guards.find((g) => g.tool === "cancel_job")!;
	assert.equal(await cancel.ask({ id: 7 }, situation([])), undefined);
	assert.deepEqual(await cancel.ask({ id: 7 }, situation(["fetch_url"])), { summary: `cancel job 7 "Backups", after reading outside text (fetch_url)` });
});

test("a job keeps its last 3 reports, each cut short", () => {
	const job: Job = { taskId: 1, title: "t", instruction: "i", schedule: { kind: "once", at: 1 }, mode: "report", createdAt: 0, runs: 0, quietRuns: 2 };
	for (let i = 0; i < 4; i += 1) recordReport(job, i, i === 3 ? "z".repeat(900) : `report ${i}`);
	assert.deepEqual(job.recent!.map((r) => r.text.length), [8, 8, 801]);
	assert.equal(job.quietRuns, 0);
});

test("the API lists jobs, pauses, resumes and cancels them, and the transcript shows reports", async (t) => {
	const instance = startInstance(async () => new MemoryStorage(), faux([fauxAssistantMessage(fauxText("Morning: all quiet."))]), { notify: async () => undefined });
	t.after(() => instance.close());
	const api = createApi(instance, { token: "t", local: false, env: envFrom({}), see: () => undefined, credentials: new Credentials(), describe: () => ({}) });
	const headers = { authorization: "Bearer t", "content-type": "application/json" };
	const post = (path: string, body: object) => api(new Request(`http://dreamwalker.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
	const get = async (path: string) => (await api(new Request(`http://dreamwalker.test${path}`, { headers }))).json();
	const host = (await instance.host())!;
	const later = await host.root.commit((tx) => host.jobs.addJob(tx, host.root.id, { title: "Later", instruction: "x", schedule: { kind: "every", minutes: 1440, from: Date.now() + 86_400_000 }, mode: "report" }), context);
	await host.root.commit((tx) => host.jobs.addJob(tx, host.root.id, { title: "Morning", instruction: "Brief me.", schedule: { kind: "once", at: Date.now() + 100 }, mode: "report" }), context);

	assert.deepEqual((await get("/api/jobs")).jobs.map((j: Job) => j.title), ["Morning", "Later"]);
	assert.equal((await (await post("/api/jobs/pause", { id: later.taskId })).json()).paused.reason, "paused by the owner");
	assert.equal((await post("/api/jobs/pause", { id: later.taskId })).status, 404);
	assert.equal((await (await post("/api/jobs/resume", { id: later.taskId })).json()).paused, undefined);
	assert.equal((await post("/api/jobs/cancel", { id: later.taskId })).status, 200);
	assert.equal((await post("/api/jobs/cancel", { id: later.taskId })).status, 404);

	const line = await until(async () => (await get("/api/transcript")).lines.find((l: { kind: string }) => l.kind === "job"));
	assert.deepEqual([line.title, line.text, line.delivered, line.paused], ["Morning", "Morning: all quiet.", true, false]);
});
