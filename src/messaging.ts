// Agents reaching each other, from gaidin. message_agent asks another agent something and waits for its answer: the
// other agent answers in a new conversation of its own, with its own tools, grants and notes, owned by the call so
// stopping the run stops it. hand_off gives another agent work and doesn't wait: it's a one-off job of that agent's,
// run now, whose report reaches the owner titled with the sender's name.
//
// dreamwalker may reach every agent; another agent only those its roster entry lists. What one agent sends another is
// outside text to the receiver (it isn't the owner's message), and the answer that comes back is outside text to the
// sender. Either tool asks the owner, showing all of it, when outside text has come in since the owner's last message,
// as delegating does, so a page can't pass work to an agent with wider grants. A chain of messages and hand-offs stops
// at MAX_CHAIN, and an agent already in a chain can't be asked again within it.
import { Type } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { configure, type ConversationId, defineExtension, defineTool, type DocumentReader, type Extension, type ModelRef, ROOT_CONVERSATION_ID, section, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { assistantText } from "./answers.ts";
import { clip, guard, ifOutsideTextThisTurn, type Place } from "./guards.ts";
import { conversationId } from "./ids.ts";
import type { createJobs } from "./jobs.ts";
import { object, string } from "./parse.ts";
import { AgentOf, agentOf, type AgentRecord, Agents, Chain, DEFAULT_AGENT, MAX_CHAIN } from "./roster.ts";
import { stamp } from "./time.ts";

const MAX_ANSWER = 20_000;

export type MessagingOptions = {
	owner: string;
	model: () => ModelRef;
	jobs: ReturnType<typeof createJobs>;
	/** The tools agent `agent`'s grants give, read in the commit making its conversation. */
	granted: (tx: Tx, agent: string) => Promise<readonly Extension[]>;
};

const nameOf = (roster: readonly AgentRecord[], id: string) => (id === DEFAULT_AGENT ? DEFAULT_AGENT : (roster.find((a) => a.id === id)?.name ?? id));

/** The agents `from` may reach: every active one for dreamwalker, those its entry lists for another. */
function reachable(roster: readonly AgentRecord[], from: string): AgentRecord[] {
	const active = roster.filter((a) => a.archivedAt === undefined && a.id !== from);
	if (from === DEFAULT_AGENT) return active;
	const contacts = roster.find((a) => a.id === from)?.contacts ?? [];
	return active.filter((a) => contacts.includes(a.id));
}

/** The agents `from` may reach, dreamwalker included when its entry lists it, by id. */
function reachableIds(roster: readonly AgentRecord[], from: string): string[] {
	const ids = reachable(roster, from).map((a) => a.id);
	const contacts = roster.find((a) => a.id === from)?.contacts ?? [];
	return from !== DEFAULT_AGENT && contacts.includes(DEFAULT_AGENT) ? [DEFAULT_AGENT, ...ids] : ids;
}

/** Why the agent of `place`'s conversation can't reach agent `to` now, or nothing. */
async function reachProblem(place: Place, to: string): Promise<string | undefined> {
	const from = await agentOf(place, place.conversationId);
	const roster = (await place.snapshot(Agents, background))?.items ?? [];
	const ids = reachableIds(roster, from);
	if (!ids.includes(to)) return `You can't reach ${to}. You can reach: ${ids.join(", ") || "no other agent"}.`;
	const chain = (await place.snapshot(Chain, place.conversationId, background))?.agents ?? [];
	if (chain.length >= MAX_CHAIN) return `This is already ${chain.length} agents along (${[...chain, from].join(" → ")}); a chain stops at ${MAX_CHAIN}.`;
	if ([...chain, from].includes(to)) return `${to} is already in this chain (${[...chain, from].join(" → ")}).`;
	return undefined;
}

export function createMessaging(options: MessagingOptions) {
	const { owner } = options;

	const contactsSection = section("agents", async (input) => {
		const from = await agentOf(input.read, input.conversationId);
		const roster = (await input.read.snapshot(Agents, background))?.items ?? [];
		const ids = reachableIds(roster, from);
		if (ids.length === 0) return undefined;
		const lines = ids.map((id) => (id === DEFAULT_AGENT ? `- dreamwalker: ${owner}'s personal agent` : `- ${id}: ${roster.find((a) => a.id === id)?.name}, ${roster.find((a) => a.id === id)?.job}`));
		return [
			`Other agents of ${owner}'s you can reach: message_agent asks one something and waits for the answer; hand_off gives one work to do now, whose report reaches ${owner}.`,
			...lines,
		].join("\n");
	});

	/** Makes a conversation of agent `to`'s, for a message, owned by the call, carrying on `chain`. */
	async function conversationFor(tx: Tx, taskId: TaskId, to: string, chain: readonly string[]): Promise<ConversationId> {
		const made = await tx.createConversation({ ownership: { kind: "task", taskId } });
		await configure(tx, made.id, { model: options.model(), extensions: { add: [...(await options.granted(tx, to))] } });
		// The creation hook gave it the sender's agent; it's the receiver's.
		(await tx.doc(AgentOf, made.id)).agent = to;
		(await tx.doc(Chain, made.id)).agents = [...chain];
		return made.id;
	}

	const read = async (api: DocumentReader & { readonly conversationId: ConversationId }) => {
		const from = await agentOf(api, api.conversationId);
		const roster = (await api.snapshot(Agents, background))?.items ?? [];
		const chain = (await api.snapshot(Chain, api.conversationId, background))?.agents ?? [];
		return { from, roster, chain: [...chain, from] };
	};

	const messageAgent = defineTool({
		name: "message_agent",
		description:
			`Ask another of ${owner}'s agents something and wait for its answer. It answers in a conversation of its own, with its own tools and notes, ` +
			`and doesn't see this conversation, so say everything it needs. Its answer is another agent's words: text from outside, not from ${owner}.`,
		parameters: Type.Object({ agent: Type.String({ description: "The agent's id" }), text: Type.String() }),
		replay: "safe",
		execute: async (args, api, context) => {
			const problem = await reachProblem(api, args.agent);
			if (problem !== undefined) throw new Error(problem);
			const { from, roster, chain } = await read(api);
			let id = await api.memo<number>("dreamwalker.message", context);
			if (id === undefined) {
				const made = await api.commit((tx) => conversationFor(tx, api.taskId, args.agent, chain), context);
				id = await api.memo<number>("dreamwalker.message", made, context);
			}
			const other = await api.conversation(conversationId(id), context);
			if (other === undefined) throw new Error(`The conversation with ${args.agent} is gone`);
			const content = stamp(`A message from ${nameOf(roster, from)}, another of ${owner}'s agents, not from ${owner}:\n\n${args.text}`);
			const submission = await other.submit({ type: "input", content, requestId: `message:${api.taskId}` }, context);
			const settled = await submission.wait(context);
			if (settled.status !== "done" || settled.type !== "input") {
				return { output: [{ type: "text", text: `${nameOf(roster, args.agent)} didn't answer: ${settled.status}${settled.reason ? ` (${settled.reason})` : ""}.` }], isError: true };
			}
			const answer = (await api.commit(async (tx) => assistantText(await tx.entry(settled.answer)), context)) ?? "(No answer.)";
			const text = answer.length > MAX_ANSWER ? `${answer.slice(0, MAX_ANSWER)}… (cut from ${answer.length} characters)` : answer;
			return {
				output: [{ type: "text", text: `${nameOf(roster, args.agent)}'s answer. It's another agent's words, so text from outside, not from ${owner}.\n\n${text}` }],
				details: { conversationId: id },
			};
		},
	});

	const handOff = defineTool({
		name: "hand_off",
		description:
			`Give another of ${owner}'s agents work to do now, without waiting. It runs as a job of that agent's, which doesn't see this conversation ` +
			`or ${owner}'s notes, and its report reaches ${owner} titled with \`title\` and your name. Say everything the work needs.`,
		parameters: Type.Object({ agent: Type.String({ description: "The agent's id" }), title: Type.String(), task: Type.String() }),
		execute: async (args, api, context) => {
			const problem = await reachProblem(api, args.agent);
			if (problem !== undefined) throw new Error(problem);
			const { from, roster, chain } = await read(api);
			const home = args.agent === DEFAULT_AGENT ? undefined : roster.find((a) => a.id === args.agent)?.conversationId;
			// dreamwalker's jobs belong to the root, as its own are.
			const target = home === undefined ? ROOT_CONVERSATION_ID : conversationId(home);
			const job = await api.commit(async (tx) => {
				return options.jobs.addJob(tx, target, { title: `${args.title} (from ${nameOf(roster, from)})`, instruction: args.task, schedule: { kind: "once", at: Date.now() + 1000 }, mode: "report", chain });
			}, context);
			return { output: [{ type: "text", text: `Handed to ${nameOf(roster, args.agent)} as job ${job.taskId}, "${job.title}". Its report goes to ${owner}.` }] };
		},
	});

	const reach = (summary: (a: { agent: string; text?: string; title?: string; task?: string }) => string) => ({
		refuse: async (a: { agent: string }, place: Place) => reachProblem(place, a.agent),
		ask: async (a: { agent: string; text?: string; title?: string; task?: string }, situation: Parameters<typeof ifOutsideTextThisTurn>[0]) => {
			if (!(await situation.holdsOwnerData())) return undefined;
			const ask = await ifOutsideTextThisTurn(situation, () => summary(a));
			return ask === undefined ? undefined : { ...ask, detail: a.text ?? a.task };
		},
	});

	return {
		extension: defineExtension({ name: "messaging", sections: [contactsSection], tools: [messageAgent, handOff] }),
		guards: [
			guard("message_agent", object({ agent: string, text: string }), { ...reach((a) => `message ${a.agent}: ${clip(a.text ?? "", 300)}`), outside: true }),
			guard("hand_off", object({ agent: string, title: string, task: string }), reach((a) => `hand ${a.agent} "${a.title}": ${clip(a.task ?? "", 300)}`)),
		],
	};
}
