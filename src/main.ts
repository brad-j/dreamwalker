#!/usr/bin/env -S node --no-warnings
// The dreamwalker command: talks to a deployed server, or to `netlify dev`, through its API.
import { parseArgs } from "node:util";
import type { BudgetStatus } from "./budget.ts";
import { clientSettingsFrom, createClient } from "./client.ts";

const USAGE = `usage: dreamwalker COMMAND

  ask [--id ID] "MESSAGE"   send a message and print the answer; the same --id finds the
                            same run instead of asking twice
  status                    the instance, its storage, budget and model credentials
  budget                    today's and this month's spend against the limits
  allow [AMOUNT]            let today go AMOUNT dollars past the daily limit, or another
                            day's limit
  wake                      wake the server, which resumes whatever was waiting
  memory                    the notes dreamwalker keeps about you, which every prompt sees
  remember "TEXT"           add a note
  forget ID                 delete a note, such as n3
  requests                  what's waiting for you: calls to allow and questions
  approve ID                allow a call
  deny ID                   refuse a call
  answer ID "TEXT"          answer a question; IDs can be shortened to their start
  jobs                      scheduled jobs, soonest first
  pause-job ID, resume-job ID, cancel-job ID
                            pause a job's runs, start them again, or end it

DREAMWALKER_URL and DREAMWALKER_TOKEN come from the environment or .env.`;

const money = (n: number) => `$${n.toFixed(2)}`;

function printBudget(b: BudgetStatus) {
	const limit = (n: number) => (n > 0 ? money(n) : "no limit");
	console.log(`today      ${money(b.today)} of ${limit(b.dailyLimit)}`);
	console.log(`this month ${money(b.month)} of ${limit(b.monthlyLimit)}`);
	if (b.stopped) console.log(`stopped: ${b.reason ?? "a limit was reached"}`);
}

/** The waiting request whose id starts with `prefix`, as `requests` shows them shortened. */
async function fullId(client: ReturnType<typeof createClient>, prefix: string): Promise<string> {
	const matches = (await client.requests()).requests.filter((r) => r.id.startsWith(prefix));
	if (matches.length === 1) return matches[0]!.id;
	throw new Error(matches.length === 0 ? `nothing waiting starts with ${prefix}` : `${prefix} matches ${matches.length} requests; give more of it`);
}

async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({ args: argv, options: { id: { type: "string" }, help: { type: "boolean", short: "h" } }, allowPositionals: true });
	const [command, ...rest] = positionals;
	if (values.help || command === undefined || command === "help") {
		console.log(USAGE);
		return command === undefined && !values.help ? 1 : 0;
	}
	const client = createClient(clientSettingsFrom(process.env));
	switch (command) {
		case "ask": {
			const message = rest.join(" ").trim();
			if (message === "") throw new Error('ask needs a message: dreamwalker ask "..."');
			console.log(await client.ask(message, values.id));
			return 0;
		}
		case "status":
			console.log(JSON.stringify(await client.status(), null, 2));
			return 0;
		case "budget":
			printBudget(await client.budget());
			return 0;
		case "allow": {
			const amount = rest[0] === undefined ? undefined : Number(rest[0].replace(/^\$/, ""));
			if (amount !== undefined && !(amount > 0)) throw new Error(`allow takes a dollar amount more than 0, not ${rest[0]}`);
			printBudget(await client.allow(amount));
			return 0;
		}
		case "memory": {
			const { notes, maxTotal } = await client.memory();
			for (const n of notes) console.log(`n${n.id}  ${n.text}${n.by === "owner" ? "" : `  (${n.by})`}`);
			console.log(`${notes.length === 0 ? "no notes yet; " : ""}${notes.reduce((sum, n) => sum + n.text.length, 0)} of ${maxTotal} characters`);
			return 0;
		}
		case "remember": {
			const text = rest.join(" ").trim();
			if (text === "") throw new Error('remember needs the note: dreamwalker remember "..."');
			const note = await client.remember(text);
			console.log(`n${note.id}  ${note.text}`);
			return 0;
		}
		case "forget":
			if (rest[0] === undefined) throw new Error("forget needs a note id, such as n3");
			await client.forget(rest[0]);
			console.log(`forgot ${rest[0]}`);
			return 0;
		case "requests": {
			const { requests } = await client.requests();
			if (requests.length === 0) console.log("nothing waiting");
			for (const r of requests) console.log(`${r.id.slice(0, 8)}  ${r.kind === "question" ? "question" : r.tool}: ${r.summary}${r.choices === undefined ? "" : `  [${r.choices.join(" / ")}]`}`);
			return 0;
		}
		case "approve":
		case "deny":
		case "answer": {
			if (rest[0] === undefined) throw new Error(`${command} needs a request id; dreamwalker requests lists them`);
			const id = await fullId(client, rest[0]);
			if (command === "answer") {
				const text = rest.slice(1).join(" ").trim();
				if (text === "") throw new Error('answer needs the answer: dreamwalker answer ID "..."');
				console.log(`answered: ${(await client.answer(id, text)).summary}`);
			} else {
				const done = await client.decide(id, command === "deny" ? "deny" : "once");
				console.log(`${done.status}: ${done.summary}`);
			}
			return 0;
		}
		case "jobs": {
			const { jobs } = await client.jobs();
			if (jobs.length === 0) console.log("no scheduled jobs");
			for (const j of jobs) {
				const when = j.paused !== undefined ? `paused: ${j.paused.reason}` : j.nextAt === undefined ? "done" : `next ${new Date(j.nextAt).toLocaleString()}`;
				const last = j.lastAt === undefined ? "" : `, last ${new Date(j.lastAt).toLocaleString()} (${j.lastResult}${j.failures ? `, ${j.failures} failed in a row` : ""})`;
				console.log(`${j.taskId}  ${j.title}${j.mode === "watch" ? " (watch)" : ""}: ${when}${last}`);
			}
			return 0;
		}
		case "pause-job":
		case "resume-job":
		case "cancel-job": {
			const id = Number(rest[0]);
			if (!Number.isInteger(id)) throw new Error(`${command} needs a job id; dreamwalker jobs lists them`);
			const action = command === "pause-job" ? "pause" : command === "resume-job" ? "resume" : "cancel";
			const job = await client.job(action, id);
			console.log(`${{ pause: "paused", resume: "resumed", cancel: "cancelled" }[action]}: ${job.title}`);
			return 0;
		}
		case "wake":
			console.log((await client.wake()) ? "awake" : "not awake");
			return 0;
		default:
			console.error(`unknown command: ${command}\n\n${USAGE}`);
			return 1;
	}
}

main(process.argv.slice(2)).then(
	(code) => (process.exitCode = code),
	(error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	},
);
