// Guards, from gaidin: each tool's approval rules, declared by the module that owns the tool and returned beside its
// extension. A guard says what a call asks the owner, why a call can't succeed at all, and whether the tool's results
// are text from outside. The approvals hook (approvals.ts) applies them: it refuses, asks and waits.
//
//   guard("forget", object({ id: noteId }), {
//     ask: (a, situation) => ifOutsideText(situation, () => `forget note n${a.id}`),
//   })
import type { Context } from "@earendil-works/chord";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { DocumentReader, JsonObject, SessionDocToken } from "@earendil-works/pi-durable";
import type { ApprovalRequest } from "./approvals.ts";
import { parse, type Parser } from "./parse.ts";

/** What a call asks the owner. `detail` holds what the summary can't, so the owner sees all of what they allow. */
export type Ask = Pick<ApprovalRequest, "summary" | "detail">;

/** One of dreamwalker's session documents as it stands. */
export type Snapshot = <T extends JsonObject>(doc: SessionDocToken<T>) => Promise<Readonly<T> | undefined>;

/** What a guard can see when it decides whether a call asks. */
export type Situation = {
	/** The conversation the call is in. */
	conversationId: number;
	/** The call's id, which its tool's execution sees as `api.callId`. */
	callId: string;
	/** The outside-text tools whose results are in the conversation's context. It reads the context, so call it only when it matters. */
	outside: () => Promise<string[]>;
	/** The same, counting only what came in since the owner's last message. */
	outsideThisTurn: () => Promise<string[]>;
	/** Whether the conversation holds the owner's notes: the main agent's does, a job run's or a worker's doesn't. */
	holdsOwnerData: () => Promise<boolean>;
	snapshot: Snapshot;
};

type Awaitable<T> = T | Promise<T>;
/** A call's arguments as the model gave them. */
type Args = ToolCall["arguments"];

/** A tool's approval rules as the approvals hook reads them. Made with `guard`. */
export type Guard = {
	readonly tool: string;
	/** Its results are text from outside, which some other calls ask after (`ifOutsideText`). */
	readonly outside: boolean;
	/** The call is told what outside text came before it (`outsideBefore` in outside.ts), to keep with what it stores. */
	readonly tracksOutside: boolean;
	/** What the call asks, or nothing. Throws a ParseError when the arguments don't read right. */
	readonly ask: (args: Args, situation: Situation) => Promise<Ask | undefined>;
	/** Why the call can't succeed, read from the current state, or nothing. Checked before asking and again after an approval. Throws a ParseError when the arguments don't read right. */
	readonly refuse: (args: Args, read: DocumentReader, context: Context) => Promise<string | undefined>;
};

/** A guard for `tool`, whose rules get the call's arguments as `parser` reads them. */
export function guard<A>(
	tool: string,
	parser: Parser<A>,
	rules: {
		ask?: (args: A, situation: Situation) => Awaitable<Ask | undefined>;
		refuse?: (args: A, read: DocumentReader, context: Context) => Awaitable<string | undefined>;
		outside?: true;
		tracksOutside?: true;
	},
): Guard {
	const { ask, refuse } = rules;
	const read = (args: Args) => parse(args, parser, `${tool}'s arguments`);
	return {
		tool,
		outside: rules.outside === true,
		tracksOutside: rules.tracksOutside === true,
		ask: async (args, situation) => (ask === undefined ? undefined : ask(read(args), situation)),
		refuse: async (args, reader, context) => (refuse === undefined ? undefined : refuse(read(args), reader, context)),
	};
}

/** Asks with `summary` only while outside text is in the conversation, naming where it came from. */
export async function ifOutsideText(situation: Situation, summary: () => Awaitable<string>): Promise<Ask | undefined> {
	const read = await situation.outside();
	if (read.length === 0) return undefined;
	return { summary: `${await summary()}, after reading outside text (${read.join(", ")})` };
}

/**
 * Asks with `summary` only while outside text read since the owner's last message is in the conversation, naming where
 * it came from: a call that follows from what was just read, before the owner has said anything more.
 */
export async function ifOutsideTextThisTurn(situation: Situation, summary: () => Awaitable<string>): Promise<Ask | undefined> {
	const read = await situation.outsideThisTurn();
	if (read.length === 0) return undefined;
	return { summary: `${await summary()}, after reading outside text since your last message (${read.join(", ")})` };
}

/** `text` cut to `max` characters, saying how long it was. */
export const clip = (text: string, max = 1500) => (text.length > max ? `${text.slice(0, max)}… (${text.length} characters)` : text);

/** ` "text"`, clipped, or nothing when there's no text. */
export const quoted = (text: string | undefined) => (text === undefined ? "" : ` "${clip(text, 200)}"`);
