// The Harness and the root conversation, over whichever storage it's given: Netlify Database on the platform, Pi's
// in-memory storage in tests and for `DREAMWALKER_STORAGE=memory`. Every model request passes the spend guard first, and everything
// told to the owner unprompted (reminders, budget warnings) goes through notifications.ts.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, createRegistry, defineExtension, Harness, section, type Storage } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { assistantText } from "./answers.ts";
import { approvalExtension, ApprovalService } from "./approvals.ts";
import { type BudgetSettings, budgetSettingsFrom, createBudget } from "./budget.ts";
import { createFetch, type FetchOptions } from "./fetch.ts";
import { createJobs } from "./jobs.ts";
import { createSearch, type SearchBackend } from "./search.ts";
import { createMemory } from "./memory.ts";
import { type Chosen } from "./model.ts";
import { type Adapters, createNotifications } from "./notifications.ts";
import { createReminders } from "./reminders.ts";
import { setTimeZone, stamp } from "./time.ts";
import { createWorker } from "./worker.ts";
import { createWorkspace } from "./workspace.ts";

export const context = BACKGROUND_CONTEXT;

export type HostOptions = {
	/** What dreamwalker calls the owner, in its prompt and tool descriptions. Default: "the user". */
	owner?: string;
	/** Default: $5 a day, $50 a month, days and times in UTC. Its time zone is the one times are shown in. */
	budget?: BudgetSettings;
	/** The ways to reach the owner. Default: none, so notices go to the server's log. */
	adapters?: Adapters;
	/** Replaces how the spend guard tells the owner; tests use it. Default: through the adapters. */
	notify?: (text: string) => Promise<void>;
	/** Replaces how the spend guard totals spend; tests use it. */
	spend?: (harness: Harness) => Promise<number>;
	/** How fetch_url resolves names and which addresses it refuses; tests replace them. */
	fetch?: FetchOptions;
	/** How long a request waits for the owner. Default: 7 days. */
	approvalTimeoutMs?: number;
	/** How web_search searches; without one there's no web_search, as on the faux model. */
	search?: SearchBackend;
	/**
	 * The worker's computer, where its read, write, edit and bash run: `env` makes it at each use for a task's directory,
	 * and `clear` clears what a task left once it ends. Without one there are none.
	 */
	workspace?: { env: (dir: string) => ExecutionEnv; clear: (dir: string) => Promise<void> };
};

export async function openHost(storage: Storage, chosen: Chosen, options: HostOptions = {}) {
	const owner = options.owner ?? "the user";
	const settings = options.budget ?? budgetSettingsFrom({});
	setTimeZone(settings.timeZone);
	const notifications = createNotifications(options.adapters ?? {});
	const budget = createBudget({
		settings,
		notify: options.notify ?? ((text) => notifications.send({ kind: "budget", text })),
		spend: options.spend,
	});
	const reminders = createReminders((reminder) => notifications.send({ kind: "reminder", reminder }), owner);
	// A run the spend guard refused says why, rather than counting as the job failing.
	const jobs = createJobs({
		deliver: (report) => notifications.send(report.paused === true ? { kind: "paused", report } : { kind: "report", report }),
		owner,
		explain: (reason) => (reason === "no_model" ? budget.blocked() : undefined),
	});
	const preamble = defineExtension({
		name: "dreamwalker",
		sections: [
			section(
				"preamble",
				() =>
					`You are dreamwalker, ${owner}'s personal agent. Each of ${owner}'s messages starts with the local time in brackets, ` +
					`which is the time to use for anything said about "now", "today" or "at 3".`,
				{ tag: false },
			),
		],
	});
	const memory = createMemory(owner);
	// What a worker works with: the way out to the internet, which the main agent doesn't have (worker.ts).
	const web = createFetch(options.fetch, owner);
	const search = options.search === undefined ? undefined : createSearch(options.search, owner);
	const workspace = options.workspace === undefined ? undefined : createWorkspace(owner);
	const workerTools = [web.extension, ...(search === undefined ? [] : [search.extension]), ...(workspace?.extensions ?? [])];
	const worker = createWorker({ owner, model: chosen.model, tools: [...workerTools, budget.extension], clear: options.workspace?.clear });
	const guards = [...web.guards, ...(search?.guards ?? []), ...(workspace?.guards ?? []), ...worker.guards, ...memory.guards, ...reminders.guards, ...jobs.guards];
	// The service needs the Harness, which needs the registry; the hook reads it once something calls.
	let approvals: ApprovalService | undefined;
	// The main agent's tools, which every conversation has unless it says otherwise: the root, and the runs of jobs.
	const main = [preamble, memory.extension, reminders.extension, jobs.extension, worker.extension, approvalExtension(() => approvals!, owner, () => guards), budget.extension];
	const registry = createRegistry();
	for (const extension of [...main, worker.instructions, ...workerTools]) registry.install(extension);
	const harness = await Harness.open(
		storage,
		{
			models: budget.guard(chosen.models),
			registry,
			// Only a worker's conversation has a directory, so only workers get a computer.
			env: (target) => (target.cwd === undefined ? undefined : options.workspace?.env(target.cwd)),
			// Partial answers and tool output are committed at most this often. Remote storage pays per commit.
			settings: { extensions: main, progress: { partialIntervalMs: 500, outputIntervalMs: 500 } },
			onReport: (error) => console.error("[report]", error),
		},
		context,
	);
	const root = await harness.root(context, { agent: { model: chosen.model } });
	// The conversation keeps the model it was made with; the site's setting decides it instead, so a conversation started
	// on another model (the faux one before Claude was switched on) doesn't ask for one this server doesn't have.
	await root.configure({ model: chosen.model }, context);
	approvals = new ApprovalService(harness, { timeoutMs: options.approvalTimeoutMs });
	// After the root exists, before anything runs: a resumed run is checked against the limits too.
	await budget.attach(harness);
	harness.resume();

	/** Why a run ended unanswered, in words. A run the spend guard refused says which limit. */
	const explain = (reason: string) => (reason === "no_model" ? (budget.blocked() ?? `no_model: ${chosen.model.provider}/${chosen.model.modelId} isn't in the model catalog`) : reason);

	/**
	 * Sends `message` to the root conversation, stamped with the time, and waits for the answer. `requestId` makes a retry
	 * find the same run. A message while a question waits is its answer; one while a call waits for approval closes that
	 * request, so the run goes on and the message is answered after it.
	 */
	async function ask(message: string, requestId?: string, by = "cli") {
		if ((await approvals!.intercept(root.id, message, by)) === "answered") return { ok: true as const, text: "", answered: true };
		const submission = await root.submit({ type: "input", content: stamp(message), requestId }, context);
		const settled = await submission.wait(context);
		if (settled.status !== "done" || settled.type !== "input") return { ok: false as const, reason: settled.status === "unanswered" ? explain(settled.reason) : "not an input" };
		const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		return { ok: true as const, text: assistantText(answer) ?? "" };
	}

	/** Queues `message` without waiting for the answer, for callers that can't hold a request open that long. True when it answered a question instead. */
	async function send(message: string, requestId?: string, by = "web"): Promise<boolean> {
		if ((await approvals!.intercept(root.id, message, by)) === "answered") return true;
		await root.submit({ type: "input", content: stamp(message), requestId }, context);
		return false;
	}

	/** Whether the root conversation is working on something: a run in progress or queued, not a reminder waiting. */
	async function busy(): Promise<boolean> {
		return root.commit(async (tx) => {
			for (const status of ["pending", "running", "waiting", "completing"] as const) {
				if ((await tx.scanTasks({ conversationId: root.id, background: false, status }, 1)).items.length > 0) return true;
			}
			return false;
		}, context);
	}

	return { harness, root, ask, send, busy, budget, reminders, jobs, approvals, close: () => harness.close(context) };
}

export type Host = Awaited<ReturnType<typeof openHost>>;
