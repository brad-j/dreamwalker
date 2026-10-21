// Where the text in a conversation's context came from: the owner, or outside. The guards ask about it (guards.ts).
//
// The owner's messages are marked where they come in, as `OwnerMessage` entries (host.ts). Everything else the model
// reads as a user message is outside text unless shown otherwise: a job's prompt, which carries its earlier reports; a
// handoff; any kind of message added later. A compaction summary stands in for the history it replaced, so it's outside
// text when that history had any. Tool results are outside text when their tool's guard says so.
//
// The owner's messages from before they were marked were plain `pi.user` entries in the root conversation, the only
// ones there; those up to `OwnerMarks.since` are the owner's.
import type { Message } from "@earendil-works/pi-ai";
import { CompactionEntry, type ContextView, defineDoc, defineEntry, type EntryRecord, type HookApi, ROOT_CONVERSATION_ID, UserEntry } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { isObject } from "./parse.ts";

/** A message from the owner, through the API. */
export const OwnerMessage = defineEntry<{ by: string }>("dreamwalker.owner");

/** The newest entry from before the owner's messages were marked: unmarked messages in the root up to it are the owner's. */
export const OwnerMarks = defineDoc<{ since: number }>({ kind: "dreamwalker.owner-marks", version: 1, scope: "session", initial: () => ({ since: -1 }) });

export const SUMMARY = "an earlier part of the conversation, summarized";
export const NOT_THE_OWNER = "a message not from the owner";

type Reader = {
	/** Whether a tool's results are outside text. */
	isOutside: (tool: string) => boolean;
	/** The call being decided, whose placeholder result is skipped. */
	callId?: string;
	/** `OwnerMarks.since`, or -1 before it's set. */
	since: number;
	/** Whether the history a compaction summary replaced had outside text. */
	summarized: (summary: EntryRecord) => Promise<boolean>;
};

const owners = (entry: EntryRecord, conversationId: number, since: number) =>
	OwnerMessage.is(entry) || (UserEntry.is(entry) && conversationId === ROOT_CONVERSATION_ID && Number(entry.id) <= since);

/** Where one entry's text came from: "owner", the outside sources it adds, or nothing for the agent's own. */
function sourceOf(entry: EntryRecord, messages: readonly Message[], conversationId: number, reader: Omit<Reader, "summarized">): "owner" | string[] {
	if (owners(entry, conversationId, reader.since)) return "owner";
	return messages.flatMap((message) => {
		if (message.role === "user") return [NOT_THE_OWNER];
		if (message.role !== "toolResult" || message.toolCallId === reader.callId) return [];
		const details = message.details ?? null;
		const flagged = isObject(details) && details.outside === true;
		return reader.isOutside(message.toolName) || flagged ? [message.toolName] : [];
	});
}

/**
 * The outside sources in a conversation's context: all of them, and those since the owner's last message. A compaction
 * summary counts once its history is checked; any other user message not the owner's counts as it is.
 */
export async function provenance(view: ContextView, conversationId: number, reader: Reader): Promise<{ all: string[]; thisTurn: string[] }> {
	const all = new Set<string>();
	let thisTurn = new Set<string>();
	for (const [i, entry] of view.entries.entries()) {
		let found: "owner" | string[];
		if (CompactionEntry.is(entry)) found = (await reader.summarized(entry)) ? [SUMMARY] : [];
		else found = sourceOf(entry, view.contributions[i] ?? [], conversationId, reader);
		if (found === "owner") {
			thisTurn = new Set();
			continue;
		}
		for (const source of found) {
			all.add(source);
			thisTurn.add(source);
		}
	}
	return { all: [...all], thisTurn: [...thisTurn] };
}

/** The memo a guarded call's outside sources are kept under, for a guard that tracks them (guards.ts). */
export const OUTSIDE_BEFORE = "dreamwalker.outside-before";

/**
 * The outside sources in the conversation when this call was decided, for a tool whose guard tracks them. Without the
 * record, as in a conversation the approvals hook doesn't run in, there's no telling, so it counts as outside.
 */
export async function outsideBefore(api: Pick<HookApi, "memo">, context: Context): Promise<string[]> {
	return (await api.memo<string[]>(OUTSIDE_BEFORE, context)) ?? ["a conversation it couldn't check"];
}
