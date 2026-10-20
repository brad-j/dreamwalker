// Reminders, from gaidin, for one agent and the owner's phone: gaidin's speakers, agents and the guard on cancelling
// come with the modules they belong to. A reminder is a background task that sleeps until its time, so it survives a
// restart, and one that came due while the server was asleep fires as soon as it wakes.
import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineDoc, defineEntry, defineExtension, defineTask, defineTool, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { formatClock, formatTime } from "./time.ts";

export type Reminder = { taskId: number; text: string; at: number };
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

	async function add(tx: Tx, conversationId: ConversationId, text: string, at: number): Promise<number> {
		// Background: the conversation goes idle while it waits, and stopping a run doesn't cancel it.
		const id = await tx.createTask(ReminderTask, { text, at }, { ownership: { kind: "conversation" }, conversationId, background: true });
		(await tx.doc(Reminders)).items.push({ taskId: id, text, at });
		return id;
	}

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
			const taskId = await api.commit((tx) => add(tx, api.conversationId, args.text, at), context);
			return { output: [{ type: "text", text: `Reminder ${taskId} set for ${formatTime(at)}${soon(at)}: ${args.text}` }] };
		},
	});

	const listReminders = defineTool({
		name: "list_reminders",
		description: "List open reminders with their ids and times.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async (_args, api, context) => {
			const items = (await api.snapshot(Reminders, context))?.items ?? [];
			const text = items.length === 0 ? "No open reminders." : [...items].sort((a, b) => a.at - b.at).map((r) => `${r.taskId}: ${formatTime(r.at)}: ${r.text}`).join("\n");
			return { output: [{ type: "text", text }] };
		},
	});

	const cancelReminder = defineTool({
		name: "cancel_reminder",
		description: "Cancel an open reminder by id.",
		parameters: Type.Object({ id: Type.Number() }),
		replay: "safe",
		execute: async (args, api, context) => {
			const removed = await api.commit((tx) => removeReminder(tx, args.id), context);
			const text = removed ? `Cancelled ${args.id}: ${removed.text}` : `No open reminder ${args.id}.`;
			return { output: [{ type: "text", text }] };
		},
	});

	return {
		ReminderTask,
		extension: defineExtension({
			name: "reminders",
			tools: [remind, listReminders, cancelReminder],
			tasks: [ReminderTask],
		}),
	};
}

export type ReminderTaskId = TaskId<Result>;
