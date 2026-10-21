// The Harness and the root conversation, over whichever storage it's given: Netlify Database on the platform, Pi's
// in-memory storage in tests and for `DREAMWALKER_STORAGE=memory`. Every model request passes the spend guard first, and everything
// told to the owner unprompted (reminders, budget warnings) goes through notifications.ts.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, createRegistry, Harness, type Storage } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createAgents, identity } from "./agents.ts";
import { assistantText } from "./answers.ts";
import { approvalExtension, ApprovalService } from "./approvals.ts";
import { type BudgetSettings, budgetSettingsFrom, createBudget } from "./budget.ts";
import { createFetch, type FetchOptions } from "./fetch.ts";
import { createHistory, type HistoryStore } from "./history.ts";
import { createJobs } from "./jobs.ts";
import { createSearch, type SearchBackend } from "./search.ts";
import { createMemory } from "./memory.ts";
import { type Chosen } from "./model.ts";
import { type Adapters, createNotifications } from "./notifications.ts";
import { OwnerMarks, OwnerMessage } from "./outside.ts";
import { Agents, DEFAULT_AGENT, inheritAgent } from "./roster.ts";
import { createNetlify, type NetlifySettings } from "./netlify.ts";
import { redaction, type Secret } from "./redact.ts";
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
	/** Where past conversations are indexed for search_history (history.ts); without one they can't be searched. */
	history?: HistoryStore;
	/** The server's secrets as they stand, redacted from every tool result (redact.ts). Default: none. */
	secrets?: () => readonly Secret[];
	/** The Netlify tools' token and team, and a fake API for tests; without settings the tools say they aren't set up. */
	netlify?: { settings?: NetlifySettings; fetch?: typeof globalThis.fetch };
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
	const memory = createMemory(owner);
	const history = createHistory(options.history, owner);
	// The tools an agent can be granted beyond the main agent's.
	const netlify = createNetlify(options.netlify?.settings, { fetch: options.netlify?.fetch });
	const grants = { netlify: [netlify.extension] };
	const granted = (names: readonly string[] | undefined) => (names ?? []).flatMap((g) => (g === "netlify" ? grants.netlify : []));
	const jobs = createJobs({
		deliver: (report) => notifications.send(report.paused === true ? { kind: "paused", report } : { kind: "report", report }),
		owner,
		explain: (reason) => (reason === "no_model" ? budget.blocked() : undefined),
		runExtensions: async (tx, agent) => ({ add: granted((await tx.doc(Agents)).items.find((a) => a.id === agent)?.grants), remove: [memory.extension] }),
	});
	const preamble = identity(owner);
	// What a worker works with: the way out to the internet, which the main agent doesn't have (worker.ts).
	const web = createFetch(options.fetch, owner);
	const search = options.search === undefined ? undefined : createSearch(options.search, owner);
	const workspace = options.workspace === undefined ? undefined : createWorkspace(owner);
	const redacting = redaction(options.secrets ?? (() => []));
	const workerTools = [web.extension, ...(search === undefined ? [] : [search.extension]), ...(workspace?.extensions ?? []), redacting];
	const worker = createWorker({ owner, model: chosen.model, tools: [...workerTools, budget.extension], clear: options.workspace?.clear });
	const guards = [...web.guards, ...(search?.guards ?? []), ...(workspace?.guards ?? []), ...worker.guards, ...netlify.guards, ...history.guards, ...memory.guards, ...reminders.guards, ...jobs.guards];
	// The service needs the Harness, which needs the registry; the hook reads it once something calls.
	let approvals: ApprovalService | undefined;
	// The main agent's tools, which every conversation has unless it says otherwise: the root, and the runs of jobs.
	const main = [preamble, memory.extension, history.extension, reminders.extension, jobs.extension, worker.extension, approvalExtension(() => approvals!, owner, () => guards), budget.extension, redacting];
	const registry = createRegistry();
	for (const extension of new Set([...main, worker.instructions, ...workerTools, netlify.extension])) registry.install(extension);
	const harness = await Harness.open(
		storage,
		{
			models: budget.guard(chosen.models),
			registry,
			// A job's run or a worker belongs to the agent whose conversation made it.
			conversationCreated: inheritAgent,
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
	// The owner's messages from before they were marked are the root's plain user messages so far.
	await root.commit(async (tx) => {
		const marks = await tx.doc(OwnerMarks);
		if (marks.since >= 0) return;
		const newest = (await tx.scanEntries({ conversationId: root.id }, 1)).items[0];
		marks.since = newest === undefined ? 0 : Number(newest.id);
	}, context);
	approvals = new ApprovalService(harness, { timeoutMs: options.approvalTimeoutMs });
	const agents = createAgents(harness, () => chosen.model, grants);
	await agents.configureHomes();
	// The index follows commits from here; catching each home up runs in the background, so a long first one after a
	// deploy doesn't hold up the request that opened the host.
	const historyCaughtUp = history.attach(harness);
	historyCaughtUp.catch((error) => console.error("[history] catching up:", error));
	// After the root exists, before anything runs: a resumed run is checked against the limits too.
	await budget.attach(harness);
	harness.resume();

	/** Why a run ended unanswered, in words. A run the spend guard refused says which limit. */
	const explain = (reason: string) => (reason === "no_model" ? (budget.blocked() ?? `no_model: ${chosen.model.provider}/${chosen.model.modelId} isn't in the model catalog`) : reason);

	/** The owner's message as a submission: stamped with the time, and marked as theirs (outside.ts). */
	const fromOwner = (message: string, by: string, requestId?: string) =>
		({ type: "input", content: stamp(message), requestId, entry: { kind: OwnerMessage.kind, data: { by } } }) as const;

	/**
	 * Sends `message` to the root conversation, stamped with the time, and waits for the answer. `requestId` makes a retry
	 * find the same run. A message while a question waits is its answer; one while a call waits for approval closes that
	 * request, so the run goes on and the message is answered after it.
	 */
	async function ask(message: string, requestId?: string, by = "cli", agent = DEFAULT_AGENT) {
		const home = await agents.home(agent);
		if ((await approvals!.intercept(home.id, message, by)) === "answered") return { ok: true as const, text: "", answered: true };
		const submission = await home.submit(fromOwner(message, by, requestId), context);
		const settled = await submission.wait(context);
		if (settled.status !== "done" || settled.type !== "input") return { ok: false as const, reason: settled.status === "unanswered" ? explain(settled.reason) : "not an input" };
		const answer = await home.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		return { ok: true as const, text: assistantText(answer) ?? "" };
	}

	/** Queues `message` without waiting for the answer, for callers that can't hold a request open that long. True when it answered a question instead. */
	async function send(message: string, requestId?: string, by = "web", agent = DEFAULT_AGENT): Promise<boolean> {
		const home = await agents.home(agent);
		if ((await approvals!.intercept(home.id, message, by)) === "answered") return true;
		await home.submit(fromOwner(message, by, requestId), context);
		return false;
	}

	/** Whether the root conversation is working on something: a run in progress or queued, not a reminder waiting. */
	async function busy(agent = DEFAULT_AGENT): Promise<boolean> {
		const home = await agents.home(agent);
		return home.commit(async (tx) => {
			for (const status of ["pending", "running", "waiting", "completing"] as const) {
				if ((await tx.scanTasks({ conversationId: home.id, background: false, status }, 1)).items.length > 0) return true;
			}
			return false;
		}, context);
	}

	return { harness, root, agents, netlify, historyCaughtUp, ask, send, busy, budget, reminders, jobs, approvals, close: () => harness.close(context) };
}

export type Host = Awaited<ReturnType<typeof openHost>>;
