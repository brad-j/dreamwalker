// The root conversation as the app draws it: the owner's messages, the answers, each tool call with what came back,
// and reminders as they fired. Built from Pi Durable's entries, newest last; the model's thinking and Pi's own
// records (system prompts, compactions) stay out.

import { AssistantEntry, type Conversation, type EntryRecord, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { context } from "./host.ts";
import { ApprovalSettled } from "./approvals.ts";
import { JobReported } from "./jobs.ts";
import { ReminderFired } from "./reminders.ts";
import { OwnerMessage } from "./outside.ts";

export type Line =
	| { kind: "you"; id: number; at: number; text: string }
	| { kind: "answer"; id: number; at: number; text: string }
	| { kind: "tool"; id: number; at: number; name: string; args: string; result?: string; error: boolean }
	| { kind: "reminder"; id: number; at: number; text: string; delivered: boolean }
	| { kind: "job"; id: number; at: number; title: string; text: string; delivered: boolean; paused: boolean; runConversation: number }
	| { kind: "approval"; id: number; at: number; tool: string; summary: string; status: string; decision?: string; by?: string; question: boolean; answer?: string };

/** A message's text: the string, or its text parts joined. */
const textOf = (content: string | readonly { type: string; text?: string }[]) => (Array.isArray(content) ? content.flatMap((c) => (c.type === "text" && c.text !== undefined ? [c.text] : [])).join("") : String(content));

/** The owner's message without the time stamp the host put in front of it. */
const unstamped = (text: string) => text.replace(/^\[[^\]]*\] /, "");

/** The lines of `entries`, oldest first, each tool call paired with its result. */
export function linesOf(entries: readonly EntryRecord[]): Line[] {
	const lines: Line[] = [];
	const calls = new Map<string, Extract<Line, { kind: "tool" }>>();
	for (const entry of entries) {
		const message = entry.model?.[0];
		// The owner's messages: marked as theirs, or plain user messages from before they were marked.
		if ((OwnerMessage.is(entry) || UserEntry.is(entry)) && message?.role === "user") {
			lines.push({ kind: "you", id: entry.id, at: message.timestamp, text: unstamped(textOf(message.content)) });
		} else if (AssistantEntry.is(entry) && message?.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "toolCall") {
					const call: Extract<Line, { kind: "tool" }> = { kind: "tool", id: entry.id, at: message.timestamp, name: part.name, args: JSON.stringify(part.arguments), error: false };
					calls.set(part.id, call);
					lines.push(call);
				}
			}
			const text = textOf(message.content.filter((c) => c.type === "text"));
			if (text !== "") lines.push({ kind: "answer", id: entry.id, at: message.timestamp, text });
		} else if (ToolResultEntry.is(entry) && message?.role === "toolResult") {
			const call = calls.get(message.toolCallId);
			if (call !== undefined) {
				call.result = textOf(message.content);
				call.error = message.isError;
			}
		} else if (ApprovalSettled.is(entry) && entry.data !== undefined) {
			const d = entry.data;
			lines.push({ kind: "approval", id: entry.id, at: d.decidedAt ?? 0, tool: d.tool, summary: d.summary, status: d.status, decision: d.decision, by: d.by, question: d.kind === "question", answer: d.answer });
		} else if (JobReported.is(entry) && entry.data !== undefined) {
			const d = entry.data;
			lines.push({ kind: "job", id: entry.id, at: d.at ?? 0, title: d.title, text: d.text, delivered: d.delivered, paused: d.paused === true, runConversation: d.conversationId });
		} else if (ReminderFired.is(entry) && entry.data !== undefined) {
			lines.push({ kind: "reminder", id: entry.id, at: entry.data.at, text: entry.data.text, delivered: entry.data.delivered });
		}
	}
	return lines;
}

/** The newest `limit` entries of `conversation`, as lines. */
export async function transcript(conversation: Conversation, limit = 300): Promise<Line[]> {
	const page = await conversation.commit((tx) => tx.scanEntries({ conversationId: conversation.id, order: "descending" }, limit), context);
	return linesOf([...page.items].reverse());
}
