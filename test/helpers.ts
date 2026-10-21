// What the tests share: Pi's faux model, scripted step by step, and a way to wait for something to happen.
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

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
