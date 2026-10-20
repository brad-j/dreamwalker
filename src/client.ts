// The API from the other side: what the dreamwalker command uses to talk to a deployed server, or to `netlify dev`.
// Answers are parsed here, at the boundary; a refusal becomes an error carrying the server's own words.

import { randomUUID } from "node:crypto";
import { array, boolean, type Json, number, object, optional, parse, type Parser, string } from "./parse.ts";

export type ClientSettings = { url: string; token: string | undefined };

/** The client settings from the environment: `DREAMWALKER_URL` and `DREAMWALKER_TOKEN`, as `.env` holds them. */
export function clientSettingsFrom(env: NodeJS.ProcessEnv): ClientSettings {
	const url = env.DREAMWALKER_URL;
	if (url === undefined || url === "") throw new Error("DREAMWALKER_URL isn't set. Put it in .env, or use http://localhost:8888 under netlify dev.");
	return { url, token: env.DREAMWALKER_TOKEN || undefined };
}

export class ApiError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

const Answer = object({ answer: string });
const Failure = object({ error: string });
const Woke = object({ awake: boolean });
const NoteAnswer = object({ id: number, text: string, by: string });
const NotesAnswer = object({ notes: array(NoteAnswer), maxNote: number, maxTotal: number });
const Ok = object({ ok: boolean });
const BudgetAnswer = object({ today: number, month: number, dailyLimit: number, monthlyLimit: number, stopped: boolean, reason: optional(string) });

export function createClient(settings: ClientSettings, request: typeof fetch = fetch) {
	async function call<T>(path: string, parser: Parser<T>, init: { method?: string; body?: Json } = {}): Promise<T> {
		const headers = new Headers({ "content-type": "application/json" });
		if (settings.token !== undefined) headers.set("authorization", `Bearer ${settings.token}`);
		const response = await request(new URL(path, settings.url), { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
		const text = await response.text();
		let body: Json;
		try {
			body = JSON.parse(text);
		} catch {
			throw new ApiError(`${response.status} from ${path}, not JSON: ${text.slice(0, 200)}`, response.status);
		}
		if (!response.ok) {
			const error = Failure(body, "the error").error;
			throw new ApiError(response.status === 401 ? `${error}: check DREAMWALKER_TOKEN` : error, response.status);
		}
		return parse(body, parser, `the answer from ${path}`);
	}

	return {
		/** Sends a message and waits for the answer. The same `requestId` finds the same run instead of asking twice. */
		ask: async (message: string, requestId: string = randomUUID()) => (await call("/api/ask", Answer, { method: "POST", body: { message, requestId } })).answer,
		/** The instance, the storage, the budget and the model's credentials, as the server reports them. */
		status: () => call("/api/status", (value) => value),
		budget: () => call("/api/budget", BudgetAnswer),
		/** Allows today `amount` dollars more, or another day's limit. */
		allow: (amount?: number) => call("/api/budget/allow", BudgetAnswer, { method: "POST", body: amount === undefined ? {} : { amount } }),
		wake: async () => (await call("/api/wake", Woke)).awake,
		/** The notes dreamwalker keeps, and their limits. */
		memory: () => call("/api/memory", NotesAnswer),
		remember: (text: string) => call("/api/memory/add", NoteAnswer, { method: "POST", body: { text } }),
		forget: async (id: string) => (await call("/api/memory/forget", Ok, { method: "POST", body: { id } })).ok,
	};
}

export type Client = ReturnType<typeof createClient>;
