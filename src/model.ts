// Which model answers. The faux model needs no key or network, for local runs and tests; anything else is Claude.
//
// Claude goes through Netlify's AI Gateway, which puts ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL in the environment
// while a request is being handled, and only then. Reminders, jobs and runs resumed after a restart call the model
// outside any request, so the credentials are kept from the last time they were seen (every request looks, and
// /api/wake brings one every few minutes) and read at each model call. A key set on the site wins: the Gateway never
// overrides it, and it's in the environment all the time.

import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef } from "@earendil-works/pi-durable";
import { platformEnv, type ReadEnv } from "./environment.ts";

export type ModelSettings = { provider: "faux" } | { provider: "anthropic"; id: string };

export type Chosen = { models: Models; model: ModelRef };

/** The model settings from the environment: `DREAMWALKER_MODEL=faux`, or Claude, `DREAMWALKER_MODEL_ID` picking which. */
export function modelSettingsFrom(env: NodeJS.ProcessEnv): ModelSettings {
	if (env.DREAMWALKER_MODEL === "faux") return { provider: "faux" };
	return { provider: "anthropic", id: env.DREAMWALKER_MODEL_ID ?? "claude-haiku-5-5" };
}

type Seen = { apiKey: string; baseUrl: string | undefined; at: number };

/** The newest Anthropic credentials the environment has shown. */
export class Credentials {
	#seen: Seen | undefined;
	#now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** Keeps the credentials `read` shows now, if any. The key and base URL are kept together, as they came. */
	see(read: ReadEnv) {
		const apiKey = read("ANTHROPIC_API_KEY");
		if (apiKey === undefined) return;
		this.#seen = { apiKey, baseUrl: read("ANTHROPIC_BASE_URL"), at: this.#now() };
	}

	/** The newest credentials, looking at the environment first. */
	current(read: ReadEnv): Seen | undefined {
		this.see(read);
		return this.#seen;
	}

	/** What the status route shows: where the model is reached and how old the credentials are, never the key. */
	describe(read: ReadEnv) {
		const seen = this.current(read);
		if (seen === undefined) return { credentials: "none seen yet" };
		return { credentials: seen.baseUrl === undefined ? "a key set on the site" : "the AI Gateway", baseHost: seen.baseUrl === undefined ? "api.anthropic.com" : new URL(seen.baseUrl).host, ageSeconds: Math.round((this.#now() - seen.at) / 1000) };
	}
}

/** `models` with each model's base URL replaced by the Gateway's, when the credentials came with one. */
function throughGateway(models: Models, baseUrl: () => string | undefined): Models {
	return new Proxy(models, {
		get(target, key) {
			if (key === "getModel") {
				return (provider: string, id: string) => {
					const model = target.getModel(provider, id);
					const url = baseUrl();
					return model === undefined || url === undefined ? model : { ...model, baseUrl: url };
				};
			}
			// SAFETY: a get trap is only asked for keys of the object it wraps.
			const value = target[key as keyof Models];
			return value instanceof Function ? value.bind(target) : value;
		},
	});
}

/** The faux model answers every message by quoting it back, so a run is visible end to end without a key. */
export function modelFor(settings: ModelSettings, credentials = new Credentials(), read: ReadEnv = platformEnv): Chosen {
	if (settings.provider === "faux") {
		const models = createModels();
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		const step = (ctx: { messages: readonly { role: string; content?: unknown }[] }) => {
			const last = ctx.messages.findLast((m) => m.role === "user");
			// What the owner typed, without the time stamp in front of it.
			const said = JSON.stringify(last?.content).replace(/^"\[[^\]]*\] /, '"');
			return fauxAssistantMessage(fauxText(`You said: ${said}`));
		};
		faux.setResponses(Array.from({ length: 1000 }, () => step));
		models.setProvider(faux.provider);
		return { models, model: { provider: "faux", modelId: "faux-1" } };
	}
	const models = createModels({
		authContext: {
			env: async (name) => (name === "ANTHROPIC_API_KEY" ? credentials.current(read)?.apiKey : undefined),
			fileExists: async () => false,
		},
	});
	models.setProvider(anthropicProvider());
	return { models: throughGateway(models, () => credentials.current(read)?.baseUrl), model: { provider: "anthropic", modelId: settings.id } };
}
