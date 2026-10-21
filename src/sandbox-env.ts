// The agent's ExecutionEnv over a Netlify Sandbox: Pi Durable's coding tools (read, write, edit, bash) work through it
// as they would on a local machine, and everything they do happens in the sandbox. The work itself is done there, by
// Pi's own NodeExecutionEnv, which sandbox/helper.mjs runs once per operation; this side only carries requests and
// answers. A one-off operation is one command; a command the agent runs, or a watch, is a process whose output this
// reads by offset as it comes. The helper and Pi's environment are installed in the sandbox on first use, once per
// version of them (src/sandbox-files.ts).
//
// A Box is the part of the sandbox SDK this needs, so tests can stand a local one in for a real sandbox.
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
	type BinaryReader,
	type DirReader,
	err,
	ExecutionError,
	type ExecutionEnv,
	FileError,
	type FileErrorCode,
	type FileInfo,
	type FileWatcher,
	type LineScan,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type ShellOutputSkip,
	type TextLine,
	type TextLineReader,
	type WatchChange,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
import type { Sandbox } from "plinthwick";
import { isObject, type Json } from "./parse.ts";
import { SANDBOX_FILES, SANDBOX_VERSION } from "./sandbox-files.ts";

export type BoxOutput = { exitCode: number; stdout: string; stderr: string; truncated: boolean };
export type BoxProcess = { read(): Promise<{ stdout: string; stderr: string; truncated: boolean }>; readonly exited: boolean; kill(): Promise<void> };
export type Box = {
	run(argv: string[]): Promise<BoxOutput>;
	start(argv: string[]): Promise<BoxProcess>;
	writeFile(path: string, text: string): Promise<void>;
};

/** The SDK's sandbox as a Box. */
export function boxOf(sandbox: Sandbox): Box {
	return {
		run: (argv) => sandbox.commands.run(argv),
		start: async (argv) => {
			const process = await sandbox.commands.start(argv);
			return {
				read: () => process.read(),
				get exited() {
					return process.exited;
				},
				kill: async () => void (await process.kill()),
			};
		},
		writeFile: (path, text) => sandbox.files.write(path, text),
	};
}

/** What crosses to and from the helper: JSON, with bytes as `{ __b64 }` and a field left out as undefined. */
type Value = null | boolean | number | string | Uint8Array | readonly Value[] | Fields;
type Fields = { readonly [key: string]: Value | undefined };

const isFields = (value: Value | undefined): value is Fields => value instanceof Object && !Array.isArray(value) && !(value instanceof Uint8Array);

function toWire(value: Value | undefined): Json {
	if (value === undefined || value === null) return null;
	if (value instanceof Uint8Array) return { __b64: Buffer.from(value).toString("base64") };
	if (isFields(value)) return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, toWire(v)]));
	if (Array.isArray(value)) return value.map(toWire);
	// SAFETY: what's left is a boolean, a number or a string, which JSON holds as it is.
	return value as boolean | number | string;
}

function fromWire(value: Json): Value {
	if (isObject(value)) {
		const b64 = value.__b64;
		if (Object.keys(value).length === 1 && b64 !== undefined) return new Uint8Array(Buffer.from(String(b64), "base64"));
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromWire(v)]));
	}
	if (Array.isArray(value)) return value.map(fromWire);
	return value;
}

/** A value the helper sent as what Pi's NodeExecutionEnv gave it: the T its operation returns. */
function sent<T>(value: Value | undefined): T {
	// SAFETY: the helper sends what Pi's own environment returned for the operation, which is a T, and fromWire gives back
	// its bytes as they were.
	return value as T;
}

const FILE_CODES: readonly FileErrorCode[] = ["aborted", "not_found", "permission_denied", "not_directory", "is_directory", "invalid", "not_supported", "unknown"];
const EXEC_CODES: readonly ExecutionError["code"][] = ["aborted", "timeout", "shell_unavailable", "spawn_error", "callback_error", "unknown"];

const field = (value: Value | undefined, key: string): Value | undefined => (isFields(value) ? value[key] : undefined);
const text = (value: Value | undefined) => (value === undefined || value === null ? undefined : String(value));

function fileError(error: Value | undefined): FileError {
	const code = FILE_CODES.find((c) => c === text(field(error, "code"))) ?? "unknown";
	return new FileError(code, text(field(error, "message")) ?? "The sandbox's helper failed", text(field(error, "path")));
}

function executionError(error: Value | undefined): ExecutionError {
	const code = EXEC_CODES.find((c) => c === text(field(error, "code"))) ?? "unknown";
	const made = new ExecutionError(code, text(field(error, "message")) ?? "The command failed in the sandbox");
	const spill = text(field(error, "spillPath"));
	if (spill !== undefined) made.spillPath = spill;
	return made;
}

/** One of the helper's one-off answers as a Result; `value` comes back as Pi's NodeExecutionEnv returned it. */
function resultOf<T>(answer: Value): Result<T, FileError> {
	if (field(answer, "ok") === true) return ok<T, FileError>(sent<T>(field(answer, "value")));
	return err<T, FileError>(fileError(field(answer, "error")));
}

const aborted = <T>(path?: string) => err<T, FileError>(new FileError("aborted", "aborted", path));
const closed = <T>(what: string, path: string) => err<T, FileError>(new FileError("invalid", `${what} is closed`, path));
const failed = <T>(cause: unknown, path?: string) => err<T, FileError>(new FileError("unknown", cause instanceof Error ? cause.message : String(cause), path, cause instanceof Error ? cause : undefined));

/** Installs reached by this process, by sandbox, version and working directory, so each is checked once. */
const installs = new Map<string, Promise<void>>();

/** Arguments longer than this are staged in files first: Linux takes at most 128 KiB in one. */
const MAX_ARG = 100_000;
const STAGE_PART = 512_000;
/** How often a running command's or watch's output is read, at first and once it's been quiet a while. */
const POLL_MS = 50;
const IDLE_POLL_MS = 400;

/** A helper process being followed: `ended` settles once it exits and its output has been read, or once stopped. */
type Following = { process: BoxProcess; ended: Promise<void>; stop: () => void };

export type SandboxEnvOptions = {
	/** Equal ids see the same files: one per sandbox. */
	id: string;
	cwd: string;
	box: () => Promise<Box>;
	/** Where the helper and Pi's environment are installed in the sandbox, and readers keep their links. */
	root: string;
	/**
	 * Commands get a home and a temporary directory of their own inside `cwd` (`.home`, `.tmp`, as HOME and TMPDIR), so
	 * the caches, histories and temporary files of what they run go where deleting `cwd` takes them.
	 */
	ownHome?: boolean;
};

export class SandboxEnv implements ExecutionEnv {
	readonly id: string;
	cwd: string;
	readonly #box: () => Promise<Box>;
	readonly #root: string;
	readonly #dir: string;
	readonly #ownHome: boolean;
	readonly #running = new Set<BoxProcess>();
	#boxed: Promise<Box> | undefined;

	constructor(options: SandboxEnvOptions) {
		this.id = options.id;
		this.cwd = options.cwd;
		this.#box = options.box;
		this.#root = options.root;
		this.#dir = `${options.root}/${SANDBOX_VERSION}`;
		this.#ownHome = options.ownHome === true;
	}

	/** Where commands keep their home and temporary files: their own inside `cwd`, or the sandbox's. */
	#homeVars(): { [name: string]: string } {
		return this.#ownHome ? { HOME: `${this.cwd}/.home`, TMPDIR: `${this.cwd}/.tmp` } : {};
	}

	/** The box, with the helper installed in it. */
	async #ready(): Promise<Box> {
		const boxed = (this.#boxed ??= this.#box());
		boxed.catch(() => {
			if (this.#boxed === boxed) this.#boxed = undefined;
		});
		const box = await boxed;
		const key = `${this.id}:${this.#dir}:${this.cwd}`;
		let install = installs.get(key);
		if (install === undefined) {
			install = this.#install(box);
			installs.set(key, install);
			install.catch(() => installs.delete(key));
		}
		await install;
		return box;
	}

	/** Makes the working directory, and installs the helper unless it answers already. */
	async #install(box: Box): Promise<void> {
		const made = await box.run(["mkdir", "-p", `${this.#dir}/env`, this.cwd, ...Object.values(this.#homeVars())]);
		if (made.exitCode !== 0) throw new Error(`Couldn't make the helper's and the working directory in the sandbox: ${made.stderr.trim()}`);
		const ping = await box.run(["node", `${this.#dir}/helper.mjs`, this.#arg({ op: "ping" })]).catch(() => undefined);
		if (ping !== undefined && ping.stdout.includes('"pong"')) return;
		for (const [path, contents] of Object.entries(SANDBOX_FILES)) await box.writeFile(`${this.#dir}/${path}`, contents);
		const check = await box.run(["node", `${this.#dir}/helper.mjs`, this.#arg({ op: "ping" })]);
		if (!check.stdout.includes('"pong"')) throw new Error(`The helper doesn't run in the sandbox: ${(check.stderr || check.stdout).trim()}`);
	}

	#arg(request: Fields): string {
		return Buffer.from(JSON.stringify(toWire(request))).toString("base64");
	}

	/** The command that runs the helper on `request`, staging the request in files when it's too long for an argument. */
	async #argv(box: Box, request: Fields): Promise<string[]> {
		const arg = this.#arg(request);
		if (arg.length <= MAX_ARG) return ["node", `${this.#dir}/helper.mjs`, arg];
		const parts: string[] = [];
		for (let i = 0; i < arg.length; i += STAGE_PART) {
			const part = `${this.#root}/stage-${randomUUID()}`;
			await box.writeFile(part, arg.slice(i, i + STAGE_PART));
			parts.push(part);
		}
		return ["node", `${this.#dir}/helper.mjs`, `@${parts.join(",")}`];
	}

	/** Runs a one-off request and returns the helper's answer. Throws when the helper or the sandbox fails. */
	async #request(request: Fields): Promise<Value> {
		const box = await this.#ready();
		const out = await box.run(await this.#argv(box, request));
		if (out.truncated) throw new Error("The sandbox's answer was too long to read.");
		const line = out.stdout.trim().split("\n").at(-1) ?? "";
		let answer: Value;
		try {
			answer = fromWire(JSON.parse(line));
		} catch {
			throw new Error(`The sandbox's helper didn't answer (exit ${out.exitCode}): ${(out.stderr || out.stdout).trim().slice(0, 500)}`);
		}
		const thrown = text(field(answer, "thrown"));
		if (thrown !== undefined) throw new Error(`The sandbox's helper failed: ${thrown.slice(0, 1000)}`);
		return answer;
	}

	/** One of Pi's FileSystem methods, run in the sandbox. */
	async #call<T>(method: string, args: readonly (Value | undefined)[], context: Context, path?: string): Promise<Result<T, FileError>> {
		if (context.abortSignal?.aborted) return aborted(path);
		try {
			return resultOf<T>(await this.#request({ op: "call", cwd: this.cwd, method, args: args.map((a) => a ?? null) }));
		} catch (error) {
			return failed(error, path);
		}
	}

	absolutePath(path: string, context: Context) {
		return this.#call<string>("absolutePath", [path], context, path);
	}
	joinPath(parts: string[], context: Context) {
		return this.#call<string>("joinPath", [parts], context);
	}
	readTextFile(path: string, context: Context) {
		return this.#call<string>("readTextFile", [path], context, path);
	}
	readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) {
		return this.#call<string[]>("readTextLines", [path, options], context, path);
	}
	readBinaryFile(path: string, context: Context) {
		return this.#call<Uint8Array>("readBinaryFile", [path], context, path);
	}
	writeFile(path: string, content: string | Uint8Array, context: Context) {
		return this.#call<void>("writeFile", [path, content], context, path);
	}
	appendFile(path: string, content: string | Uint8Array, context: Context) {
		return this.#call<void>("appendFile", [path, content], context, path);
	}
	truncateFile(path: string, size: number, context: Context) {
		return this.#call<void>("truncateFile", [path, size], context, path);
	}
	flushFile(path: string, context: Context) {
		return this.#call<void>("flushFile", [path], context, path);
	}
	renameFile(sourcePath: string, destinationPath: string, context: Context) {
		return this.#call<void>("renameFile", [sourcePath, destinationPath], context, sourcePath);
	}
	fileInfo(path: string, context: Context) {
		return this.#call<FileInfo>("fileInfo", [path], context, path);
	}
	listDir(path: string, context: Context) {
		return this.#call<FileInfo[]>("listDir", [path], context, path);
	}
	canonicalPath(path: string, context: Context) {
		return this.#call<string>("canonicalPath", [path], context, path);
	}
	exists(path: string, context: Context) {
		return this.#call<boolean>("exists", [path], context, path);
	}
	createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
		return this.#call<void>("createDir", [path, options], context, path);
	}
	remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) {
		return this.#call<void>("remove", [path, options], context, path);
	}
	createTempDir(prefix: string | undefined, context: Context) {
		return this.#call<string>("createTempDir", [prefix], context);
	}
	createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context) {
		return this.#call<string>("createTempFile", [options], context);
	}

	async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
		if (context.abortSignal?.aborted) return aborted(path);
		let opened: Result<{ handle: string; linked: boolean; info: FileInfo }, FileError>;
		try {
			opened = resultOf(await this.#request({ op: "open", cwd: this.cwd, path, options, handles: `${this.#root}/handles` }));
		} catch (error) {
			return failed(error, path);
		}
		if (!opened.ok) return opened;
		const { handle, linked, info } = opened.value;
		const request = (body: Fields) => this.#request(body);
		let isClosed = false;
		const reader: BinaryReader = {
			// The opened file's metadata, under the name and path it was opened by, whatever its path names now.
			info: async (ctx) => {
				if (isClosed) return closed("Binary reader", info.path);
				if (ctx.abortSignal?.aborted) return aborted(info.path);
				try {
					const now = resultOf<FileInfo>(await request({ op: "info", handle }));
					return now.ok ? ok({ ...now.value, name: info.name, path: info.path }) : now;
				} catch (error) {
					return failed(error, info.path);
				}
			},
			read: async (offset, length, ctx) => {
				if (isClosed) return closed("Binary reader", info.path);
				if (ctx.abortSignal?.aborted) return aborted(info.path);
				try {
					return resultOf<Uint8Array>(await request({ op: "range", handle, offset, length }));
				} catch (error) {
					return failed(error, info.path);
				}
			},
			scanLines: async (scan, ctx) => {
				if (isClosed) return closed("Binary reader", info.path);
				if (ctx.abortSignal?.aborted) return aborted(info.path);
				try {
					return resultOf<LineScan>(await request({ op: "scan", handle, options: scan }));
				} catch (error) {
					return failed(error, info.path);
				}
			},
			close: async () => {
				if (isClosed) return;
				isClosed = true;
				await request({ op: "close", handle, linked }).catch(() => undefined);
			},
		};
		return ok(reader);
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		if (context.abortSignal?.aborted) return aborted(path);
		const BATCH = 500;
		const batch = async (skip: number) => resultOf<{ lines: TextLine[]; done: boolean }>(await this.#request({ op: "lines", cwd: this.cwd, path, skip, count: BATCH }));
		let first: Result<{ lines: TextLine[]; done: boolean }, FileError>;
		try {
			first = await batch(0);
		} catch (error) {
			return failed(error, path);
		}
		if (!first.ok) return first;
		let buffered = [...first.value.lines];
		let read = buffered.length;
		let done = first.value.done;
		let isClosed = false;
		return ok({
			readLine: async (ctx) => {
				if (isClosed) return closed("Line reader", path);
				if (ctx.abortSignal?.aborted) return aborted(path);
				if (buffered.length === 0 && !done) {
					try {
						const next = await batch(read);
						if (!next.ok) return next;
						buffered = [...next.value.lines];
						read += buffered.length;
						done = next.value.done;
					} catch (error) {
						return failed(error, path);
					}
				}
				return ok(buffered.shift());
			},
			close: async () => {
				isClosed = true;
			},
		});
	}

	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		if (context.abortSignal?.aborted) return aborted(path);
		let listed: Result<{ path: string; names: string[] }, FileError>;
		try {
			listed = resultOf(await this.#request({ op: "dirnames", cwd: this.cwd, path }));
		} catch (error) {
			return failed(error, path);
		}
		if (!listed.ok) return listed;
		const { path: dir, names } = listed.value;
		let next = 0;
		let isClosed = false;
		return ok({
			next: async (maxEntries, ctx) => {
				if (ctx.abortSignal?.aborted) return aborted(dir);
				if (isClosed) return closed("Directory reader", dir);
				if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) return err(new FileError("invalid", "maxEntries must be a positive safe integer", dir));
				const entries: FileInfo[] = [];
				// Entries removed since the names were read are skipped, so a page is filled from the names after it.
				while (entries.length < maxEntries && next < names.length) {
					const batch = names.slice(next, next + (maxEntries - entries.length));
					next += batch.length;
					try {
						const infos = resultOf<FileInfo[]>(await this.#request({ op: "dirinfo", path: dir, names: batch }));
						if (!infos.ok) return infos;
						entries.push(...infos.value);
					} catch (error) {
						return failed(error, dir);
					}
				}
				return ok({ entries, done: next >= names.length });
			},
			close: async () => {
				isClosed = true;
			},
		});
	}

	/** Starts the helper on `request` as a process and hands each JSON line it prints to `onLine`, until it exits or `stop()`. */
	async #follow(request: Fields, onLine: (line: Value) => void): Promise<Following> {
		const box = await this.#ready();
		const process = await box.start(await this.#argv(box, request));
		this.#running.add(process);
		let stopped = false;
		let partial = "";
		const ended = (async () => {
			let wait = POLL_MS;
			try {
				while (!stopped) {
					const exitedBefore = process.exited;
					const chunk = await process.read();
					partial += chunk.stdout;
					const lines = partial.split("\n");
					partial = lines.pop() ?? "";
					for (const line of lines) if (line.trim() !== "" && !stopped) onLine(fromWire(JSON.parse(line)));
					if (exitedBefore) return;
					wait = chunk.stdout === "" ? Math.min(wait * 2, IDLE_POLL_MS) : POLL_MS;
					if (!process.exited) await new Promise((resolve) => setTimeout(resolve, wait));
				}
			} finally {
				this.#running.delete(process);
			}
		})();
		return { process, ended, stop: () => void (stopped = true) };
	}

	async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const { onOutput, ...rest } = options ?? {};
		let done: Value | undefined;
		let callbackError: Error | undefined;
		let running: Following;
		try {
			running = await this.#follow({ op: "exec", cwd: this.cwd, command, options: { cwd: rest.cwd, env: { ...this.#homeVars(), ...rest.env }, inheritEnv: rest.inheritEnv, timeout: rest.timeout, spill: rest.spill && { ...rest.spill }, window: rest.window && { ...rest.window } } }, (line) => {
				const finished = field(line, "done");
				if (finished !== undefined) {
					done = finished;
					return;
				}
				const chunk = text(field(line, "chunk"));
				if (chunk === undefined || onOutput === undefined || callbackError !== undefined) return;
				const stream = text(field(line, "stream")) === "stderr" ? "stderr" : "stdout";
				const skipped = field(line, "skipped");
				try {
					onOutput(chunk, context, skipped === undefined ? { stream } : { stream, skipped: sent<ShellOutputSkip>(skipped) });
				} catch (error) {
					callbackError = error instanceof Error ? error : new Error(String(error));
				}
			});
		} catch (error) {
			return err(new ExecutionError("spawn_error", error instanceof Error ? error.message : String(error)));
		}
		const abort = () => {
			running.stop();
			void running.process.kill().catch(() => undefined);
		};
		context.abortSignal?.addEventListener("abort", abort, { once: true });
		try {
			await running.ended;
		} finally {
			context.abortSignal?.removeEventListener("abort", abort);
		}
		if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		if (callbackError !== undefined) return err(new ExecutionError("callback_error", callbackError.message, callbackError));
		if (done === undefined) return err(new ExecutionError("unknown", "The command's helper ended without a result"));
		if (field(done, "ok") === true) return ok(sent<ShellExecResult>(field(done, "value")));
		return err(executionError(field(done, "error")));
	}

	async watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
		if (context.abortSignal?.aborted) return aborted();
		let ready: (mode: Value | undefined, failure?: Value) => void = () => undefined;
		const opened = new Promise<{ mode: Value | undefined; failure?: Value }>((resolve) => (ready = (mode, failure) => resolve({ mode, failure })));
		let isClosed = false;
		let broke = false;
		let running: Following;
		try {
			running = await this.#follow({ op: "watch", cwd: this.cwd, targets: targets.map((t) => ({ path: t.path, recursive: t.recursive, exclude: t.exclude && { hidden: t.exclude.hidden, names: t.exclude.names } })) }, (line) => {
				const mode = field(line, "ready");
				if (mode !== undefined) return ready(mode);
				const done = field(line, "done");
				if (done !== undefined && field(done, "ok") === false) return ready(undefined, field(done, "error"));
				const change = field(line, "change");
				if (change === undefined || isClosed || broke) return;
				const error = field(change, "error");
				if (error !== undefined) broke = true;
				// An error comes as {code, message, path}, to be made a FileError again.
				onChange(error === undefined ? sent<WatchChange>(change) : { error: fileError(error) });
			});
		} catch (error) {
			return failed(error);
		}
		// A watch whose process ends before it's closed has stopped: before it started, or as a failed watcher, said once.
		void running.ended
			.catch(() => undefined)
			.then(() => {
				ready(undefined, { code: "unknown", message: "The sandbox's watch stopped before it started" });
				if (!isClosed && !broke) onChange({ error: new FileError("unknown", "The sandbox's watch stopped") });
			});
		const { mode, failure } = await opened;
		if (failure !== undefined || mode === undefined) {
			running.stop();
			await running.process.kill().catch(() => undefined);
			return err(fileError(failure));
		}
		return ok({
			mode: mode === "polling" ? "polling" : "native",
			close: async () => {
				if (isClosed) return;
				isClosed = true;
				running.stop();
				await running.process.kill().catch(() => undefined);
			},
		});
	}

	/** Stops every command and watch this environment still runs. */
	async cleanup(): Promise<void> {
		await Promise.all([...this.#running].map((p) => p.kill().catch(() => undefined)));
		this.#running.clear();
	}
}
