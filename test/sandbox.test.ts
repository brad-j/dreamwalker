import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createEnvConformance, type EnvConformanceCase, type EnvConformanceProvider } from "@earendil-works/pi-durable/testing";
import { render, sandboxFiles } from "../scripts/sandbox-files.ts";
import { context } from "../src/host.ts";
import { clearTask, CLOSED_NETWORK, WORKER_NETWORK, WORKER_SANDBOX, type WorkerLayout } from "../src/sandbox.ts";
import { nodeAssertions, sandboxCheck } from "../src/sandbox-check.ts";
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

test("only the worker's sandbox reaches the internet; any other the probe makes is closed", () => {
	assert.deepEqual(CLOSED_NETWORK, { egress: "deny_all" });
	assert.deepEqual([WORKER_SANDBOX, WORKER_NETWORK], ["dreamwalker-worker", { egress: "allow_all" }]);
});

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
		assertions: nodeAssertions,
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

	test("a working directory that doesn't exist yet is made, even where the helper is installed already", async () => {
		const box = localBox();
		const root = join(dir, "cwd");
		const first = new SandboxEnv({ id: `local:${root}`, cwd: join(root, "one"), root, box: async () => box });
		assert.equal((await first.writeFile("a.txt", "a", context)).ok, true);
		const second = new SandboxEnv({ id: `local:${root}`, cwd: join(root, "two"), root, box: async () => box });
		const ran = await second.exec("pwd", undefined, context);
		assert.equal(ran.ok && ran.value.exitCode, 0);
	});

	test("with its own home, a command's HOME and TMPDIR are inside its working directory", async () => {
		const box = localBox();
		const root = join(dir, "home");
		const env = new SandboxEnv({ id: `local:${root}`, cwd: join(root, "task-1"), root, box: async () => box, ownHome: true });
		let printed = "";
		const ran = await env.exec("echo $HOME $TMPDIR; ls -A", { onOutput: (text) => (printed += text) }, context);
		assert.equal(ran.ok && ran.value.exitCode, 0);
		assert.equal(printed, `${join(root, "task-1")}/.home ${join(root, "task-1")}/.tmp\n.home\n.tmp\n`);
	});

	test("a finished task's directory is cleared; what else tasks left goes once none is running, but not what's kept", async () => {
		const box = localBox();
		const base = join(dir, "clear");
		const layout: WorkerLayout = { home: join(base, "root"), work: join(base, "root/work"), keep: [".dreamwalker", "work"], handles: join(base, "root/.dreamwalker/handles"), tmp: [join(base, "tmp")] };
		const files = ["root/work/task-1/notes.txt", "root/work/task-2/notes.txt", "root/.bash_history", "root/.cache/x", "root/visible", "root/.dreamwalker/handles/link", "root/.dreamwalker/helper.mjs", "tmp/a"];
		for (const file of files) {
			await mkdir(join(base, file, ".."), { recursive: true });
			await writeFile(join(base, file), "x");
		}
		const left = async (path: string) => (await readdir(join(base, path))).sort();
		await clearTask(box, layout, "task-1");
		assert.deepEqual(await left("root/work"), ["task-2"]);
		assert.deepEqual(await left("root"), [".bash_history", ".cache", ".dreamwalker", "visible", "work"], "another task is running");
		assert.deepEqual(await left("tmp"), ["a"]);
		await clearTask(box, layout, "task-2");
		assert.deepEqual(await left("root/work"), []);
		assert.deepEqual(await left("root"), [".dreamwalker", "work"]);
		assert.deepEqual(await left("root/.dreamwalker"), ["helper.mjs"]);
		assert.deepEqual(await left("tmp"), []);
		await assert.rejects(clearTask(box, layout, "../root"), /Not a task directory/);
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

	test("the server's check runs its cases in the background, one run at a time, each in its own directory, and clears up after", async () => {
		const box = localBox();
		const scratch = join(dir, "check");
		const cases = (withEnv: EnvConformanceProvider): EnvConformanceCase[] => [
			{ name: "writes", run: () => withEnv(async (env) => assert.equal((await env.writeFile("a.txt", "a", context)).ok, true)) },
			{ name: "starts empty", run: () => withEnv(async (env) => assert.deepEqual(await env.exists("a.txt", context), { ok: true, value: false })) },
			{ name: "fails", run: async () => assert.fail("as it should") },
		];
		const check = sandboxCheck({ id: `local:${dir}`, root: join(dir, ".dreamwalker"), box: async () => box, scratch, cases });
		const finished = async () => {
			while (check.latest()?.finishedAt === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
		};
		const run = check.start();
		assert.equal(check.start(), run);
		await finished();
		assert.deepEqual([run.total, run.passed, run.failed], [3, 2, [{ name: "fails", error: "as it should" }]]);
		const left = await new SandboxEnv({ id: `local:${dir}`, cwd: dir, root: join(dir, ".dreamwalker"), box: async () => box }).listDir(scratch, context);
		assert.deepEqual(left.ok && left.value.length, 0);
		assert.notEqual(check.start(), run, "a finished run makes way for a new one");
		await finished();
	});
});
