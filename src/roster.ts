// The agents and which one each conversation belongs to. dreamwalker itself is the default agent, whose home is the root
// conversation; the owner adds others (agents.ts), each with a home conversation of its own. Every conversation carries
// its agent in `AgentOf`, set on a home when it's made and copied from the creating conversation to every conversation
// made from it, such as a job's run or a worker, so any conversation knows its agent without looking anything up.
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { type ConversationId, type ConversationRecord, defineDoc, type DocumentReader, type Tx } from "@earendil-works/pi-durable";

export const DEFAULT_AGENT = "dreamwalker";

/**
 * One of the owner's agents. `id` is fixed once made; `name`, `job` and `instructions` can change. `sharedNotes`: whether
 * it sees the notes about the owner that every agent shares. An archived agent can't be talked to.
 */
export type AgentRecord = {
	id: string;
	name: string;
	job: string;
	instructions?: string;
	sharedNotes: boolean;
	conversationId: number;
	createdAt: number;
	archivedAt?: number;
};

export const Agents = defineDoc<{ items: AgentRecord[] }>({ kind: "dreamwalker.agents", version: 1, scope: "session", initial: () => ({ items: [] }) });

/** The agent a conversation belongs to. A fork keeps its source's. */
export const AgentOf = defineDoc<{ agent: string }>({
	kind: "dreamwalker.agent-of",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ agent: DEFAULT_AGENT }),
});

/** The agent of conversation `id`. */
export async function agentOf(read: DocumentReader, id: ConversationId): Promise<string> {
	return (await read.snapshot(AgentOf, id, background))?.agent ?? DEFAULT_AGENT;
}

/** The roster entry of agent `id`; undefined for the default agent, which has none, or one that doesn't exist. */
export async function agentRecord(read: DocumentReader, id: string): Promise<AgentRecord | undefined> {
	return (await read.snapshot(Agents, background))?.items.find((a) => a.id === id);
}

/** For `HarnessOptions.conversationCreated`: a conversation made from another belongs to that one's agent. */
export async function inheritAgent(tx: Tx, conversation: ConversationRecord): Promise<void> {
	if (conversation.owner === undefined) return;
	const from = (await tx.doc(AgentOf, conversation.owner.conversationId)).agent;
	if (from !== DEFAULT_AGENT) (await tx.doc(AgentOf, conversation.id)).agent = from;
}
