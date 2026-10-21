// Pi Durable's ExecutionEnv conformance cases, run from the server against the agent's real sandbox, so the owner can
// see the sandbox environment pass where it runs and not only against a local stand-in (test/sandbox.test.ts). The
// cases take minutes and a response has to start within a minute, so a run goes on in the background and the owner
// polls for it. Each case works in a fresh directory of its own, all removed once the run ends. The result lives only
// in this instance's memory: it's a check to look at, not state.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { type Box, SandboxEnv } from "./sandbox-env.ts";

export type CheckRun = {
	id: string;
	startedAt: string;
	finishedAt?: string;
	total: number;
	passed: number;
	failed: { name: string; error: string }[];
	/** The case running now. */
	running?: string;
};

const CASE_TIMEOUT_MS = 60_000;

/** Runs the conformance cases in the sandbox reached through `box`, under `scratch`, one run at a time. */
export function sandboxCheck(options: { id: string; root: string; box: () => Promise<Box>; scratch: string }) {
	let current: CheckRun | undefined;

	async function run(check: CheckRun) {
		const base = `${options.scratch}/${check.id}`;
		let n = 0;
		const cases = createEnvConformance({
			assertions: {
				ok: (value, message) => (message === undefined ? assert.ok(value) : assert.ok(value, message)),
				strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
				deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
				partialDeepEqual: (actual, expected) => assert.partialDeepStrictEqual(actual, expected),
				greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} > ${expected}`),
				rejects: (operation, messageIncludes) => assert.rejects(operation, (error: Error) => error.message.includes(messageIncludes)),
			},
			withEnv: async (use) => {
				n += 1;
				const cwd = `${base}/${n}`;
				const made = await (await options.box()).run(["mkdir", "-p", cwd]);
				if (made.exitCode !== 0) throw new Error(`Couldn't make ${cwd}: ${made.stderr.trim()}`);
				const env = new SandboxEnv({ id: options.id, cwd, root: options.root, box: options.box });
				try {
					await use(env);
				} finally {
					await env.cleanup();
				}
			},
		});
		check.total = cases.length;
		for (const c of cases) {
			check.running = c.name;
			let timer: NodeJS.Timeout | undefined;
			try {
				await Promise.race([
					c.run(),
					new Promise((_, reject) => {
						timer = setTimeout(() => reject(new Error(`timed out after ${(c.timeoutMs ?? CASE_TIMEOUT_MS) / 1000}s`)), c.timeoutMs ?? CASE_TIMEOUT_MS);
					}),
				]);
				check.passed += 1;
			} catch (error) {
				check.failed.push({ name: c.name, error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) });
			} finally {
				clearTimeout(timer);
			}
		}
		check.running = undefined;
		await (await options.box()).run(["rm", "-rf", base]).catch(() => undefined);
	}

	return {
		/** Starts a run unless one is going, and returns it. */
		start(): CheckRun {
			if (current !== undefined && current.finishedAt === undefined) return current;
			const check: CheckRun = { id: randomUUID(), startedAt: new Date().toISOString(), total: 0, passed: 0, failed: [] };
			current = check;
			void run(check)
				.catch((error) => check.failed.push({ name: "(the run)", error: error instanceof Error ? error.message : String(error) }))
				.finally(() => (check.finishedAt = new Date().toISOString()));
			return check;
		},
		/** The latest run, finished or not. */
		latest: (): CheckRun | undefined => current,
	};
}

export type SandboxCheck = ReturnType<typeof sandboxCheck>;
