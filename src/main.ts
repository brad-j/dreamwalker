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

DREAMWALKER_URL and DREAMWALKER_TOKEN come from the environment or .env.`;

const money = (n: number) => `$${n.toFixed(2)}`;

function printBudget(b: BudgetStatus) {
	const limit = (n: number) => (n > 0 ? money(n) : "no limit");
	console.log(`today      ${money(b.today)} of ${limit(b.dailyLimit)}`);
	console.log(`this month ${money(b.month)} of ${limit(b.monthlyLimit)}`);
	if (b.stopped) console.log(`stopped: ${b.reason ?? "a limit was reached"}`);
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
