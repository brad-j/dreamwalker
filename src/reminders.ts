// Reminders, from gaidin, for one agent and the owner's phone: gaidin's speakers and agents come with the modules they
// belong to. Cancelling asks while outside text is in the conversation, so a page can't quietly undo what the owner set. A reminder is a background task that sleeps until its time, so it survives a
// restart, and one that came due while the server was asleep fires as soon as it wakes.
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineDoc, defineEntry, defineExtension, defineTask, defineTool, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { guard, ifOutsideText, type Place, quoted } from "./guards.ts";
import { number, object, string } from "./parse.ts";
import { formatClock, formatTime } from "./time.ts";
import { outsideBefore } from "./outside.ts";
import { AgentOf, agentOf, DEFAULT_AGENT } from "./roster.ts";

/** `outside`: the outside sources in the conversation when it was set, whose text its own may carry. */
export type Reminder = { taskId: number; text: string; at: number; outside?: string[]; agent?: string };
export type Notify = (reminder: Reminder) => Promise<void>;

/** Open reminders. A reminder leaves the list when it fires or is cancelled. */
export const Reminders = defineDoc<{ items: Reminder[] }>({
	kind: "dreamwalker.reminders",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
});

/** Transcript record of a fired reminder. It carries no model messages, so the model doesn't see it. */
export const ReminderFired = defineEntry<{ text: string; at: number; delivered: boolean; error?: string; taskId?: number }>("dreamwalker.reminder-fired");

/** Takes a reminder off the open list. Its task finds itself gone when it wakes, and finishes without notifying. */
export async function removeReminder(tx: Tx, id: number): Promise<Reminder | undefined> {
	const doc = await tx.doc(Reminders);
	const found = doc.items.find((r) => r.taskId === id);
	if (found === undefined) return undefined;
	doc.items = doc.items.filter((r) => r.taskId !== id);
	return { ...found };
}

const MAX_ATTEMPTS = 5;

/** For a reminder within the hour, its exact time and how far off it is, since formatTime leaves out the seconds. */
export function soon(at: number, now = Date.now()): string {
	const seconds = Math.round((at - now) / 1000);
	if (seconds >= 3600) return "";
	const wait = seconds < 60 ? `${seconds} seconds` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
	return ` (${formatClock(at)}, in ${wait})`;
}

type State = { phase: "wait" } | { phase: "notify"; attempt: number; retryAt: number };
type Result = "sent" | "cancelled" | "failed";

export function createReminders(notify: Notify, owner = "the user") {
	const ReminderTask = defineTask<{ text: string; at: number }, State, Result>({
		name: "dreamwalker.reminder",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async (task, runtime, context) => {
				// The fire time is in the task's input, so after a restart this sleeps until the same moment.
				await runtime.sleep(task.input.at, context);
				await runtime.commit(async (tx) => {
					const open = (await tx.doc(Reminders)).items.some((r) => r.taskId === task.id);
					if (!open) return { status: "terminal", outcome: { status: "completed", result: "cancelled" } };
					return { status: "running", checkpoint: { phase: "notify", attempt: 1, retryAt: 0 } };
				}, context);
			},
			notify: async (task, runtime, context) => {
				const { attempt, retryAt } = task.state.checkpoint;
				await runtime.sleep(retryAt, context);
				const reminder = { taskId: task.id, ...task.input };
				// At least once: a crash after the push and before this commit sends it again.
				let error: string | undefined;
				try {
					await notify(reminder);
				} catch (e) {
					error = e instanceof Error ? e.message : String(e);
				}
				await runtime.commit(async (tx) => {
					const doc = await tx.doc(Reminders);
					if (error !== undefined && attempt < MAX_ATTEMPTS) {
						const delay = 2 ** attempt * 1000;
						return { status: "running", checkpoint: { phase: "notify", attempt: attempt + 1, retryAt: runtime.now() + delay } };
					}
					doc.items = doc.items.filter((r) => r.taskId !== task.id);
					const data = { ...task.input, taskId: task.id, delivered: error === undefined };
					await tx.appendEntry(ReminderFired, task.conversationId, { data: error === undefined ? data : { ...data, error } });
					return {
						status: "terminal",
						outcome: error === undefined ? { status: "completed", result: "sent" } : { status: "failed", error: { message: error }, result: "failed" },
					};
				}, context);
			},
		},
		abort: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(Reminders);
				doc.items = doc.items.filter((r) => r.taskId !== task.id);
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});

	async function add(tx: Tx, conversationId: ConversationId, text: string, at: number, outside: readonly string[] = []): Promise<number> {
		// Background: the conversation goes idle while it waits, and stopping a run doesn't cancel it.
		const id = await tx.createTask(ReminderTask, { text, at }, { ownership: { kind: "conversation" }, conversationId, background: true });
		const agent = (await tx.doc(AgentOf, conversationId)).agent;
		const reminder: Reminder = { taskId: id, text, at };
		if (outside.length > 0) reminder.outside = [...outside];
		if (agent !== DEFAULT_AGENT) reminder.agent = agent;
		(await tx.doc(Reminders)).items.push(reminder);
		return id;
	}

	/** The reminders of the agent conversation `id` belongs to: each agent sees only its own. */
	const ownReminders = async (api: Place, context: Context) => {
		const agent = await agentOf(api, api.conversationId);
		return ((await api.snapshot(Reminders, context))?.items ?? []).filter((r) => (r.agent ?? DEFAULT_AGENT) === agent);
	};

	const remind = defineTool({
		name: "remind",
		description:
			`Schedule a reminder or timer: a push notification to ${owner}'s phone. Give exactly one of \`inMinutes\` (relative) or \`at\` ` +
			"(ISO 8601 with a UTC offset, e.g. 2026-10-09T08:30:00-04:00). Check the time in the result.",
		parameters: Type.Object({
			text: Type.String({ description: `What to remind ${owner} about, as they should read it` }),
			inMinutes: Type.Optional(Type.Number({ minimum: 0, description: "Minutes from now; fractions are fine, so 0.5 is a 30-second timer" })),
			at: Type.Optional(Type.String()),
		}),
		execute: async (args, api, context) => {
			if ((args.inMinutes === undefined) === (args.at === undefined)) throw new Error("Give exactly one of inMinutes or at.");
			const at = args.at === undefined ? Date.now() + args.inMinutes! * 60_000 : Date.parse(args.at);
			if (Number.isNaN(at)) throw new Error(`Can't parse at: ${args.at}`);
			if (at < Date.now() - 60_000) throw new Error(`${formatTime(at)} is in the past.`);
			const outside = await outsideBefore(api, context);
			const taskId = await api.commit((tx) => add(tx, api.conversationId, args.text, at, outside), context);
			return { output: [{ type: "text", text: `Reminder ${taskId} set for ${formatTime(at)}${soon(at)}: ${args.text}` }] };
		},
	});

	const listReminders = defineTool({
		name: "list_reminders",
		description: "List open reminders with their ids and times.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async (_args, api, context) => {
			const items = await ownReminders(api, context);
			const flagged = (r: Reminder) => (r.outside?.length ?? 0) > 0;
			const line = (r: Reminder) => `${r.taskId}: ${formatTime(r.at)}: ${r.text}${flagged(r) ? " (set after reading outside text)" : ""}`;
			const text = items.length === 0 ? "No open reminders." : [...items].sort((a, b) => a.at - b.at).map(line).join("\n");
			// A reminder set after outside text may carry it, so the list is outside text when it shows one.
			return { output: [{ type: "text", text }], details: { outside: items.some(flagged) } };
		},
	});

	const cancelReminder = defineTool({
		name: "cancel_reminder",
		description: "Cancel an open reminder by id.",
		parameters: Type.Object({ id: Type.Number() }),
		replay: "safe",
		execute: async (args, api, context) => {
			const mine = (await ownReminders(api, context)).some((r) => r.taskId === args.id);
			const removed = mine ? await api.commit((tx) => removeReminder(tx, args.id), context) : undefined;
			const text = removed ? `Cancelled ${args.id}: ${removed.text}` : `No open reminder ${args.id}.`;
			return { output: [{ type: "text", text }] };
		},
	});

	const guards = [
		// A reminder's text is read back later by list_reminders, so a page could leave an instruction there for a later
		// turn. Setting one doesn't ask; it keeps what outside text came before it, and the list counts as outside text when
		// it shows such a reminder.
		guard("remind", object({ text: string }), { tracksOutside: true }),
		guard("cancel_reminder", object({ id: number }), {
			ask: (a, situation) => ifOutsideText(situation, async () => `cancel reminder ${a.id}${quoted((await situation.snapshot(Reminders))?.items.find((r) => r.taskId === a.id)?.text)}`),
		}),
	];

	return {
		ReminderTask,
		guards,
		extension: defineExtension({
			name: "reminders",
			tools: [remind, listReminders, cancelReminder],
			tasks: [ReminderTask],
		}),
	};
}

export type ReminderTaskId = TaskId<Result>;
