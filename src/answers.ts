// The text of an answer: what a run's final assistant entry said, for the API, job reports and the worker's results.
import { AssistantEntry, type EntryRecord } from "@earendil-works/pi-durable";

/** The text of an answer entry, if it is one and has any. */
export function assistantText(entry: EntryRecord | undefined): string | undefined {
	if (!AssistantEntry.is(entry)) return undefined;
	const message = entry.model?.[0];
	if (message?.role !== "assistant") return undefined;
	return message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("") || undefined;
}
