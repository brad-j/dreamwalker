// Pi Durable's ids, back from the plain numbers gaidin keeps them as in its own documents. Each number given to
// one of these is an id Pi Durable handed out and stored as it was, or a number from the owner that's only looked
// up, so a wrong one finds nothing.
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";

export function conversationId(id: number): ConversationId {
	// SAFETY: a conversation's id as Pi Durable gave it out (above).
	return id as ConversationId;
}

export function taskId(id: number): TaskId {
	// SAFETY: a task's id as Pi Durable gave it out (above).
	return id as TaskId;
}
