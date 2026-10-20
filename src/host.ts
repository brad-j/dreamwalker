// The Harness and the root conversation, over whichever storage it's given: Netlify Database on the platform, memory
// in tests and for `DREAMWALKER_STORAGE=memory`. Every model request passes the spend guard first.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, createRegistry, type EntryRecord, Harness, type Storage } from "@earendil-works/pi-durable";
import { type BudgetSettings, budgetSettingsFrom, createBudget } from "./budget.ts";
import { type Chosen } from "./model.ts";

export const context = BACKGROUND_CONTEXT;

/** The text of an answer entry, if it is one and has any. */
export function assistantText(entry: EntryRecord | undefined): string | undefined {
	if (!AssistantEntry.is(entry)) return undefined;
	const message = entry.model?.[0];
	if (message?.role !== "assistant") return undefined;
	return message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("") || undefined;
}

export type HostOptions = {
	/** Default: $5 a day, $50 a month, days in UTC. */
	budget?: BudgetSettings;
	/** How the spend guard tells the owner. Default: the server's log, until there's a way to reach the owner. */
	notify?: (text: string) => Promise<void>;
	/** Replaces how the spend guard totals spend; tests use it. */
	spend?: (harness: Harness) => Promise<number>;
};

export async function openHost(storage: Storage, chosen: Chosen, options: HostOptions = {}) {
	const budget = createBudget({
		settings: options.budget ?? budgetSettingsFrom({}),
		notify: options.notify ?? (async (text) => console.warn("[budget]", text)),
		spend: options.spend,
	});
	const registry = createRegistry();
	registry.install(budget.extension);
	const harness = await Harness.open(
		storage,
		{
			models: budget.guard(chosen.models),
			registry,
			// Partial answers and tool output are committed at most this often. Remote storage pays per commit.
			settings: { progress: { partialIntervalMs: 500, outputIntervalMs: 500 } },
			onReport: (error) => console.error("[report]", error),
		},
		context,
	);
	const root = await harness.root(context, { agent: { model: chosen.model } });
	// After the root exists, before anything runs: a resumed run is checked against the limits too.
	await budget.attach(harness);
	harness.resume();

	/** Why a run ended unanswered, in words. A run the spend guard refused says which limit. */
	const explain = (reason: string) => (reason === "no_model" ? (budget.blocked() ?? reason) : reason);

	/** Sends `message` to the root conversation and waits for the answer. `requestId` makes a retry find the same run. */
	async function ask(message: string, requestId?: string) {
		const submission = await root.submit({ type: "input", content: message, requestId }, context);
		const settled = await submission.wait(context);
		if (settled.status !== "done" || settled.type !== "input") return { ok: false as const, reason: settled.status === "unanswered" ? explain(settled.reason) : "not an input" };
		const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		return { ok: true as const, text: assistantText(answer) ?? "" };
	}

	return { harness, root, ask, budget, close: () => harness.close(context) };
}

export type Host = Awaited<ReturnType<typeof openHost>>;
