// Named agents, from gaidin: specialists the owner adds beside dreamwalker, each with a name, a one-line job, standing
// instructions, and a home conversation of its own. Each has its own work notes, reminders and jobs, sees the shared
// notes about the owner unless its entry turns them off (memory.ts), and works like dreamwalker otherwise: the owner's
// data in its conversations, no way out to the internet, and workers for the web (worker.ts). The roster and which
// agent a conversation belongs to are in roster.ts.
//
// Archiving an agent pauses its jobs and cancels its reminders, and it can't be talked to; its conversations and notes
// stay. Restoring it leaves its jobs paused, for the owner to resume.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { defineExtension, type Harness, type ModelRef, section } from "@earendil-works/pi-durable";
import { conversationId } from "./ids.ts";
import { Jobs, pauseJob } from "./jobs.ts";
import { Reminders, removeReminder } from "./reminders.ts";
import { AgentOf, agentOf, agentRecord, type AgentRecord, Agents, DEFAULT_AGENT } from "./roster.ts";

export const MAX_NAME = 40;
export const MAX_JOB = 200;
export const MAX_INSTRUCTIONS = 4000;

/** An agent that can't be reached: unknown (404) or archived (409). */
export class AgentUnavailable extends Error {
	readonly status: 404 | 409;

	constructor(message: string, status: 404 | 409) {
		super(message);
		this.status = status;
	}
}

/** What the owner gives a new agent. */
export type AgentFields = { name: string; job: string; instructions?: string; sharedNotes?: boolean };

/** An agent's id from its name: lowercase letters, digits and single hyphens. */
export const idFrom = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_NAME);

/** Why `fields` can't describe an agent, or nothing. */
export function agentProblem(fields: Partial<AgentFields>): string | undefined {
	if (fields.name !== undefined && (fields.name.trim() === "" || fields.name.trim().length > MAX_NAME)) return `A name is 1 to ${MAX_NAME} characters.`;
	if (fields.name !== undefined && idFrom(fields.name) === "") return "A name needs a letter or a digit.";
	if (fields.job !== undefined && (fields.job.trim() === "" || fields.job.trim().length > MAX_JOB)) return `A job is 1 to ${MAX_JOB} characters: what the agent does, in a line.`;
	if (fields.instructions !== undefined && fields.instructions.length > MAX_INSTRUCTIONS) return `Instructions are at most ${MAX_INSTRUCTIONS} characters.`;
	return undefined;
}

/** The prompt section that says who the agent is: dreamwalker, or a named agent with its job and instructions. */
export function identity(owner: string) {
	const time = `Each of ${owner}'s messages starts with the local time in brackets, which is the time to use for anything said about "now", "today" or "at 3".`;
	return defineExtension({
		name: "dreamwalker",
		sections: [
			section(
				"preamble",
				async (input) => {
					const record = await agentRecord(input.read, await agentOf(input.read, input.conversationId));
					if (record === undefined) return `You are dreamwalker, ${owner}'s personal agent. ${time}`;
					const lines = [`You are ${record.name}, one of ${owner}'s agents, beside dreamwalker, their personal agent. Your job: ${record.job}`, time];
					if (record.instructions !== undefined && record.instructions.trim() !== "") lines.push("", `${owner}'s standing instructions for you:`, record.instructions.trim());
					return lines.join("\n");
				},
				{ tag: false },
			),
		],
	});
}

export function createAgents(harness: Harness, model: () => ModelRef) {
	const roster = async () => (await harness.snapshot(Agents, background))?.items ?? [];
	const root = () => harness.root(background);

	async function get(id: string): Promise<AgentRecord> {
		const found = (await roster()).find((a) => a.id === id);
		if (found === undefined) throw new AgentUnavailable(`No agent ${id}`, 404);
		return found;
	}

	return {
		/** Every named agent, archived ones too, oldest first. */
		list: roster,

		/** The home conversation of agent `id`, dreamwalker's being the root. Throws for one that's archived or unknown. */
		async home(id: string, context: Context = background) {
			if (id === DEFAULT_AGENT) return root();
			const record = await get(id);
			if (record.archivedAt !== undefined) throw new AgentUnavailable(`${record.name} is archived`, 409);
			const conversation = await harness.conversation(conversationId(record.conversationId), context);
			if (conversation === undefined) throw new Error(`${record.name}'s conversation is gone`);
			return conversation;
		},

		/** Adds an agent with a home conversation of its own, on the site's model. */
		async add(fields: AgentFields): Promise<AgentRecord> {
			const problem = agentProblem(fields);
			if (problem !== undefined) throw new Error(problem);
			const id = idFrom(fields.name);
			if (id === DEFAULT_AGENT || (await roster()).some((a) => a.id === id)) throw new Error(`There's already an agent called ${id}`);
			const home = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: model() } }, background);
			return (await root()).commit(async (tx) => {
				(await tx.doc(AgentOf, home.id)).agent = id;
				const record: AgentRecord = { id, name: fields.name.trim(), job: fields.job.trim(), sharedNotes: fields.sharedNotes ?? true, conversationId: home.id, createdAt: Date.now() };
				if (fields.instructions !== undefined && fields.instructions.trim() !== "") record.instructions = fields.instructions.trim();
				(await tx.doc(Agents)).items.push(record);
				return { ...record };
			}, background);
		},

		/** Changes an agent's name, job, instructions or whether it sees the shared notes. Its id stays. */
		async update(id: string, changes: Partial<AgentFields>): Promise<AgentRecord> {
			const problem = agentProblem(changes);
			if (problem !== undefined) throw new Error(problem);
			await get(id);
			return (await root()).commit(async (tx) => {
				const record = (await tx.doc(Agents)).items.find((a) => a.id === id)!;
				if (changes.name !== undefined) record.name = changes.name.trim();
				if (changes.job !== undefined) record.job = changes.job.trim();
				if (changes.sharedNotes !== undefined) record.sharedNotes = changes.sharedNotes;
				if (changes.instructions !== undefined) {
					if (changes.instructions.trim() === "") delete record.instructions;
					else record.instructions = changes.instructions.trim();
				}
				return { ...record };
			}, background);
		},

		/** Archives an agent: its jobs pause, its reminders are cancelled, and it can't be talked to. */
		async archive(id: string): Promise<AgentRecord> {
			await get(id);
			return (await root()).commit(async (tx) => {
				const record = (await tx.doc(Agents)).items.find((a) => a.id === id)!;
				record.archivedAt = Date.now();
				for (const job of (await tx.doc(Jobs)).items.filter((j) => j.agent === id)) await pauseJob(tx, job.taskId, `${record.name} was archived`);
				for (const reminder of (await tx.doc(Reminders)).items.filter((r) => r.agent === id)) await removeReminder(tx, reminder.taskId);
				return { ...record };
			}, background);
		},

		/** Restores an archived agent. Its jobs stay paused, for the owner to resume. */
		async restore(id: string): Promise<AgentRecord> {
			await get(id);
			return (await root()).commit(async (tx) => {
				const record = (await tx.doc(Agents)).items.find((a) => a.id === id)!;
				delete record.archivedAt;
				return { ...record };
			}, background);
		},

		/** Moves every agent's home to the site's model, as the root is moved when the host opens. */
		async configureModels(): Promise<void> {
			for (const record of await roster()) await (await harness.conversation(conversationId(record.conversationId), background))?.configure({ model: model() }, background);
		},
	};
}

export type AgentsService = ReturnType<typeof createAgents>;
