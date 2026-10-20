// The HTTP API, as a fetch handler: the shape Netlify Server calls, and that tests call directly.
//
// Every route but /api/health and /api/wake needs the owner's token, `Authorization: Bearer <DREAMWALKER_TOKEN>`.
// Without a token set, they're refused, except under `netlify dev`.

import { createHash, timingSafeEqual } from "node:crypto";
import { platformNames, type ReadEnv, type VariableNames } from "./environment.ts";
import type { Instance } from "./instance.ts";
import type { Credentials } from "./model.ts";
import { addNote, forgetNote, MAX_NOTE, MAX_TOTAL, Memory, noteId, noteProblem, updateNote } from "./memory.ts";
import { literal, number, object, optional, parse, ParseError, type Parser, string } from "./parse.ts";
import { context } from "./host.ts";
import { Jobs, pauseJob, removeJob, resumeJob } from "./jobs.ts";
import { Reminders, removeReminder } from "./reminders.ts";
import { transcript } from "./transcript.ts";

const AskBody = object({ message: string, requestId: optional(string) });
const AllowBody = object({ amount: optional(number) });
const AddNoteBody = object({ text: string });
const UpdateNoteBody = object({ id: noteId, text: string });
const ForgetNoteBody = object({ id: noteId });
const CancelReminderBody = object({ id: number });
const DecideBody = object({ id: string, decision: literal("once", "always", "deny") });
const AnswerBody = object({ id: string, text: string });
const HostBody = object({ host: string });
const JobBody = object({ id: number });

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
	/** Makes or finds a sandbox and says what's in it, for `/api/sandbox/probe`; absent where there are no sandboxes. */
	probe?: () => Promise<Record<string, string | number>>;
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

/** Where an answer came from: the dreamwalker command says so; anything else is the app. */
const by = (request: Request) => (request.headers.get("user-agent")?.startsWith("dreamwalker-cli") ? "cli" : "web");

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
		if (url.pathname === "/api/sandbox/probe" && request.method === "POST") {
			if (options.probe === undefined) return Response.json({ error: "No sandboxes here" }, { status: 404 });
			try {
				return Response.json(await options.probe());
			} catch (error) {
				return Response.json({ error: message(error) }, { status: 502 });
			}
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
		if (url.pathname === "/api/approvals" && request.method === "GET") {
			const { fetchHosts } = await host.approvals.state();
			return Response.json({ requests: await host.approvals.pending(), fetchHosts });
		}
		if (url.pathname === "/api/approvals/decide" && request.method === "POST") {
			const body = await bodyOf(request, DecideBody);
			if (body instanceof Response) return body;
			const decided = await host.approvals.decide(body.id, body.decision, by(request));
			return decided === undefined ? Response.json({ error: "No such request waiting" }, { status: 404 }) : Response.json(decided);
		}
		if (url.pathname === "/api/approvals/answer" && request.method === "POST") {
			const body = await bodyOf(request, AnswerBody);
			if (body instanceof Response) return body;
			const answered = await host.approvals.answer(body.id, body.text, by(request));
			return answered === undefined ? Response.json({ error: "No such question waiting, or an empty answer" }, { status: 404 }) : Response.json(answered);
		}
		if (url.pathname === "/api/approvals/forget-host" && request.method === "POST") {
			const body = await bodyOf(request, HostBody);
			if (body instanceof Response) return body;
			await host.approvals.disallowHost(body.host);
			return Response.json({ ok: true });
		}
		if (url.pathname === "/api/transcript" && request.method === "GET") {
			const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 300, 1), 1000);
			return Response.json({ lines: await transcript(host.root, limit), busy: await host.busy() });
		}
		if (url.pathname === "/api/reminders" && request.method === "GET") {
			const items = (await host.harness.snapshot(Reminders, context))?.items ?? [];
			return Response.json({ reminders: [...items].sort((a, b) => a.at - b.at) });
		}
		if (url.pathname === "/api/reminders/cancel" && request.method === "POST") {
			const body = await bodyOf(request, CancelReminderBody);
			if (body instanceof Response) return body;
			const removed = await host.root.commit((tx) => removeReminder(tx, body.id), context);
			return removed === undefined ? Response.json({ error: `No open reminder ${body.id}.` }, { status: 404 }) : Response.json({ ok: true });
		}
		if (url.pathname === "/api/jobs" && request.method === "GET") {
			const items = (await host.harness.snapshot(Jobs, context))?.items ?? [];
			return Response.json({ jobs: [...items].sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity)) });
		}
		const jobAction = /^\/api\/jobs\/(cancel|pause|resume)$/.exec(url.pathname)?.[1];
		if (jobAction !== undefined && request.method === "POST") {
			const body = await bodyOf(request, JobBody);
			if (body instanceof Response) return body;
			const job = await host.root.commit((tx) => (jobAction === "cancel" ? removeJob(tx, body.id) : jobAction === "pause" ? pauseJob(tx, body.id, "paused by the owner") : resumeJob(tx, body.id)), context);
			const missing = jobAction === "cancel" ? `No job ${body.id}.` : jobAction === "pause" ? `No job ${body.id}, or it's already paused.` : `No job ${body.id}, or it isn't paused.`;
			return job === undefined ? Response.json({ error: missing }, { status: 404 }) : Response.json(job);
		}
		if (url.pathname === "/api/memory" && request.method === "GET") {
			const notes = (await host.harness.snapshot(Memory, context))?.notes ?? [];
			return Response.json({ notes, maxNote: MAX_NOTE, maxTotal: MAX_TOTAL });
		}
		if (url.pathname === "/api/memory/add" && request.method === "POST") {
			const body = await bodyOf(request, AddNoteBody);
			if (body instanceof Response) return body;
			const problem = noteProblem((await host.harness.snapshot(Memory, context))?.notes ?? [], body.text);
			if (problem !== undefined) return Response.json({ error: problem }, { status: 400 });
			return Response.json(await host.root.commit((tx) => addNote(tx, body.text, "owner"), context));
		}
		if (url.pathname === "/api/memory/update" && request.method === "POST") {
			const body = await bodyOf(request, UpdateNoteBody);
			if (body instanceof Response) return body;
			const notes = (await host.harness.snapshot(Memory, context))?.notes ?? [];
			if (!notes.some((n) => n.id === body.id)) return Response.json({ error: `No note n${body.id}.` }, { status: 404 });
			const problem = noteProblem(notes, body.text, body.id);
			if (problem !== undefined) return Response.json({ error: problem }, { status: 400 });
			return Response.json(await host.root.commit((tx) => updateNote(tx, body.id, body.text, "owner"), context));
		}
		if (url.pathname === "/api/memory/forget" && request.method === "POST") {
			const body = await bodyOf(request, ForgetNoteBody);
			if (body instanceof Response) return body;
			const removed = await host.root.commit((tx) => forgetNote(tx, body.id), context);
			return removed === undefined ? Response.json({ error: `No note n${body.id}.` }, { status: 404 }) : Response.json({ ok: true });
		}
		if (url.pathname === "/api/send" && request.method === "POST") {
			const body = await bodyOf(request, AskBody);
			if (body instanceof Response) return body;
			const answered = await host.send(body.message, body.requestId, "web");
			return Response.json({ sent: true, answered }, { status: 202 });
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
