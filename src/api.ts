// The HTTP API, as a fetch handler: the shape Netlify Server calls, and that tests call directly.
//
// Every route but /api/health and /api/wake needs the owner's token, `Authorization: Bearer <DREAMWALKER_TOKEN>`.
// Without a token set, they're refused, except under `netlify dev`.

import { createHash, timingSafeEqual } from "node:crypto";
import { platformNames, type ReadEnv, type VariableNames } from "./environment.ts";
import type { Instance } from "./instance.ts";
import type { Credentials } from "./model.ts";
import { number, object, optional, parse, ParseError, type Parser, string } from "./parse.ts";

const AskBody = object({ message: string, requestId: optional(string) });
const AllowBody = object({ amount: optional(number) });

export type ApiOptions = {
	/** The owner's token; undefined refuses every guarded route unless `local`. */
	token: string | undefined;
	/** Under `netlify dev`, where no token is needed. */
	local: boolean;
	/** The environment as the request being handled sees it. */
	env: ReadEnv;
	/** Looks at the environment on every request, keeping what only a request shows: the model's credentials, the database's address. */
	see: (read: ReadEnv) => void;
	credentials: Credentials;
	/** What the status route reports about the instance. */
	describe: () => Record<string, string | number | boolean | undefined | VariableNames>;
};

const digest = (text: string) => createHash("sha256").update(text).digest();

function allowed(request: Request, options: ApiOptions): boolean {
	if (options.token === undefined) return options.local;
	const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
	// Hashing first makes the comparison constant-time whatever the lengths.
	return given !== undefined && timingSafeEqual(digest(given), digest(options.token));
}

/** The request's JSON body as `parser` reads it, or a 400 saying what was wrong. */
async function bodyOf<T>(request: Request, parser: Parser<T>): Promise<T | Response> {
	try {
		return parse(await request.json(), parser, "the request body");
	} catch (error) {
		if (error instanceof ParseError || error instanceof SyntaxError) return Response.json({ error: error.message }, { status: 400 });
		throw error;
	}
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function createApi(instance: Instance, options: ApiOptions) {
	const replaced = () => Response.json({ error: "This instance has been replaced by a newer one" }, { status: 503, headers: { "retry-after": "5" } });
	return async (request: Request): Promise<Response> => {
		options.see(options.env);
		const url = new URL(request.url);
		if (url.pathname === "/api/health") return Response.json({ ok: true });
		// Waking needs no token: the request is the point, and opening the storage resumes whatever was waiting.
		if (url.pathname === "/api/wake") {
			try {
				return (await instance.host()) === undefined ? replaced() : Response.json({ awake: true });
			} catch (error) {
				console.error("[wake]", error);
				return Response.json({ awake: false }, { status: 503 });
			}
		}
		if (!allowed(request, options)) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
		if (url.pathname === "/api/status") {
			const storage = await instance.host().then(
				(host) => (host === undefined ? "replaced by a newer instance" : "open"),
				(error) => `failed: ${message(error)}`,
			);
			const budget = await instance.host().then(
				(host) => host?.budget.status(),
				() => undefined,
			);
			return Response.json({ ...options.describe(), storage, budget, model: options.credentials.describe(options.env), variablesNow: platformNames() });
		}
		const host = await instance.host();
		if (host === undefined) return replaced();
		if (url.pathname === "/api/budget" && request.method === "GET") return Response.json(await host.budget.refresh());
		if (url.pathname === "/api/budget/allow" && request.method === "POST") {
			// Another day's limit unless an amount is given.
			const body = await bodyOf(request, AllowBody);
			if (body instanceof Response) return body;
			const amount = body.amount ?? host.budget.limits.daily;
			if (amount <= 0) return Response.json({ error: "amount should be more than 0" }, { status: 400 });
			return Response.json(await host.budget.allowMore(amount));
		}
		if (url.pathname === "/api/ask" && request.method === "POST") {
			const body = await bodyOf(request, AskBody);
			if (body instanceof Response) return body;
			const answer = await host.ask(body.message, body.requestId);
			return answer.ok ? Response.json({ answer: answer.text }) : Response.json({ error: `unanswered: ${answer.reason}` }, { status: 502 });
		}
		return new Response("Not found", { status: 404 });
	};
}
