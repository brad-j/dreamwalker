import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { render, sandboxFiles } from "../scripts/sandbox-files.ts";
import { context } from "../src/host.ts";
import { sandboxCheck } from "../src/sandbox-check.ts";
import { type Box, type BoxProcess, SandboxEnv } from "../src/sandbox-env.ts";
import { SANDBOX_FILES } from "../src/sandbox-files.ts";

/** A Box on this machine: the sandbox SDK's commands and files, run here. */
function localBox(): Box & { runs: string[][] } {
	const runs: string[][] = [];
	return {
		runs,
		run: (argv) => {
			runs.push(argv);
			return new Promise((resolve) => {
				const [program = "", ...args] = argv;
				execFile(program, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
					const exitCode = error === null ? 0 : Number(error.code ?? 1);
					resolve({ exitCode: Number.isInteger(exitCode) ? exitCode : 1, stdout, stderr, truncated: false });
				});
			});
		},
		start: async (argv) => {
			runs.push(argv);
			const [program = "", ...args] = argv;
			const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			let exited = false;
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
			child.on("close", () => (exited = true));
			const process: BoxProcess = {
				read: async () => {
					const out = { stdout, stderr, truncated: false };
					stdout = "";
					stderr = "";
					return out;
				},
				get exited() {
					return exited;
				},
				kill: async () => {
					if (!exited) child.kill("SIGTERM");
				},
			};
			return process;
		},
		writeFile: (path, text) => writeFile(path, text),
	};
}

let dir = "";
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "dreamwalker-sandbox-"));
});
after(() => rm(dir, { recursive: true, force: true }));

describe("the sandbox's files", () => {
	test("src/sandbox-files.ts is up to date with the helper and Pi Durable (run scripts/sandbox-files.ts)", () => {
		assert.deepEqual(SANDBOX_FILES, sandboxFiles());
		assert.ok(render(sandboxFiles()).includes("SANDBOX_VERSION"));
	});
});

describe("Pi Durable's environment conformance on a sandbox", () => {
	const box = localBox();
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
			const cwd = join(dir, `work-${n}`);
			await mkdir(cwd);
			const env = new SandboxEnv({ id: `local:${dir}`, cwd, root: join(dir, ".dreamwalker"), box: async () => box });
			try {
				await use(env);
			} finally {
				await env.cleanup();
			}
		},
	});
	for (const c of cases) test(c.name, { timeout: c.timeoutMs ?? 30_000 }, () => c.run());
});

describe("the sandbox environment", () => {
	test("installs its helper once per sandbox and version", async () => {
		const box = localBox();
		const root = join(dir, "once");
		const env = () => new SandboxEnv({ id: `local:${root}`, cwd: join(root, "work"), root, box: async () => box });
		assert.equal((await env().exists(".", context)).ok, true);
		const runs = box.runs.length;
		assert.equal((await env().exists(".", context)).ok, true);
		assert.equal(box.runs.length, runs + 1);
		assert.equal(box.runs.filter((argv) => argv[0] === "mkdir").length, 1);
	});

	test("a request too long for one argument is staged in files, which the helper removes", async () => {
		const box = localBox();
		const root = join(dir, "staged");
		const env = new SandboxEnv({ id: `local:${root}`, cwd: join(root, "work"), root, box: async () => box });
		const text = "x".repeat(300_000);
		assert.equal((await env.writeFile("big.txt", text, context)).ok, true);
		const read = await env.readTextFile("big.txt", context);
		assert.equal(read.ok && read.value, text);
		assert.ok(box.runs.some((argv) => argv[2]?.startsWith("@")));
		const left = await env.listDir(root, context);
		assert.deepEqual(left.ok && left.value.map((f) => f.name).filter((name) => name.startsWith("stage-")), []);
	});

	test("a sandbox that can't be reached fails the operation instead of throwing", async () => {
		const env = new SandboxEnv({ id: "unreachable", cwd: "/work", root: "/root/.dreamwalker", box: async () => Promise.reject(new Error("no sandbox")) });
		const read = await env.readTextFile("a.txt", context);
		assert.equal(read.ok, false);
		assert.match(read.ok ? "" : read.error.message, /no sandbox/);
		const ran = await env.exec("true", undefined, context);
		assert.equal(ran.ok, false);
	});

	test("the server's check runs every conformance case in the background, one run at a time, and clears up after", async () => {
		const box = localBox();
		const scratch = join(dir, "check");
		const check = sandboxCheck({ id: `local:${dir}`, root: join(dir, ".dreamwalker"), box: async () => box, scratch });
		const run = check.start();
		assert.equal(check.start(), run);
		while (check.latest()?.finishedAt === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual(run.failed, []);
		assert.ok(run.total > 20);
		assert.equal(run.passed, run.total);
		const left = await new SandboxEnv({ id: `local:${dir}`, cwd: dir, root: join(dir, ".dreamwalker"), box: async () => box }).listDir(scratch, context);
		assert.deepEqual(left.ok && left.value, []);
	});
});
