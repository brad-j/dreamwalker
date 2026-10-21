// What the tests share: Pi's faux model, scripted step by step, a way to wait for something to happen, and what workers saw.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { conversationId } from "../src/ids.ts";

/** The faux model's answers, in order: messages, or functions of what it was sent. */
export type Steps = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];

/** Models with only the faux one, answering with `steps`, chosen. */
export function fauxModels(steps: Steps = []) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(steps);
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

/** The model calls `name` with `args`. */
export const call = (name: string, args: Record<string, string>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

/** The model answers `text`. */
export const say = (text: string) => fauxAssistantMessage(fauxText(text));

/** What the model was given as its system prompt, from the transcript's system messages. */
export const system = (ctx: { messages: readonly { role: string }[] }) => JSON.stringify(ctx.messages.filter((m) => m.role === "system"));

/** What `get` gives once it's neither undefined nor false, asking every 20ms. Throws after `timeoutMs`. */
export async function until<T>(get: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 10_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = await get();
		if (value !== undefined && value !== false) return value;
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

type Messages = Awaited<ReturnType<Conversation["context"]>>["messages"];

/** The model context of each worker the main conversation delegated to, in order, from the delegate results' details. */
export async function workers(harness: Harness, main: Conversation): Promise<Messages[]> {
	const ids = (await main.context(BACKGROUND_CONTEXT)).messages.flatMap((m) => {
		if (m.role !== "toolResult" || m.toolName !== "delegate") return [];
		const details = m.details as { conversationId?: number } | undefined;
		return details?.conversationId === undefined ? [] : [details.conversationId];
	});
	return Promise.all(ids.map(async (id) => (await (await harness.conversation(conversationId(id), BACKGROUND_CONTEXT))!.context(BACKGROUND_CONTEXT)).messages));
}

/** The text of each tool result in `messages`. */
export const toolResults = (messages: Messages) => messages.filter((m) => m.role === "toolResult").map((m) => JSON.stringify(m.content));
