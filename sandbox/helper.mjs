// dreamwalker's helper inside a Netlify Sandbox: every file operation, command and watch the agent's tools make runs
// here, through Pi Durable's own NodeExecutionEnv (./env/node.js, uploaded beside this file), so what dreamwalker
// sees is what a local environment would see. dreamwalker's server runs it once per operation, with the request as
// its one argument (base64 JSON, or @part,part,... for a large one staged in files), and reads JSON lines from its
// output:
//
//   {"ok": true, "value": ...} or {"ok": false, "error": {code, message, path}}    a one-off operation's result
//   {"chunk": "...", "stream": "stdout", "skipped"?: {...}} then {"done": result}    a command, as it runs
//   {"ready": "native"} then {"change": ...}, until stopped                          a watch
//   {"thrown": "..."}                                                                 something broke here
//
// A sandbox process has no stdin, so nothing lasts between runs but files: a binary reader is a hard link to the
// file it opened, so it keeps reading that file after a rename, and a directory reader is its names, read in pages.
// SIGTERM or SIGINT aborts what's running, so a stopped command's own processes are stopped too.
import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { NodeExecutionEnv } from "./env/node.js";

const METHODS = new Set([
	"absolutePath",
	"joinPath",
	"readTextFile",
	"readTextLines",
	"readBinaryFile",
	"writeFile",
	"appendFile",
	"truncateFile",
	"flushFile",
	"renameFile",
	"fileInfo",
	"listDir",
	"canonicalPath",
	"exists",
	"createDir",
	"remove",
	"createTempDir",
	"createTempFile",
]);

const encode = (value) =>
	value instanceof Uint8Array
		? { __b64: Buffer.from(value).toString("base64") }
		: Array.isArray(value)
			? value.map(encode)
			: value instanceof Object
				? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]))
				: value;
const decode = (value) =>
	Array.isArray(value)
		? value.map(decode)
		: value instanceof Object
			? Object.keys(value).length === 1 && "__b64" in value
				? new Uint8Array(Buffer.from(String(value.__b64), "base64"))
				: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]))
			: value;

const write = (line) => process.stdout.write(`${JSON.stringify(encode(line))}\n`);
const errorOf = (error) => ({ code: error.code, message: error.message, path: error.path, spillPath: error.spillPath });
const resultOf = (result) => (result.ok ? { ok: true, value: result.value } : { ok: false, error: errorOf(result.error) });

const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => controller.abort(new Error("aborted")));
const context = { abortSignal: controller.signal };

async function main() {
	let arg = process.argv[2] ?? "";
	// A request too long for one argument comes in parts, staged in files: @part,part,...
	if (arg.startsWith("@")) {
		const parts = arg.slice(1).split(",");
		arg = (await Promise.all(parts.map((part) => readFile(part, "utf8")))).join("");
		await Promise.all(parts.map((part) => rm(part, { force: true })));
	}
	const request = decode(JSON.parse(Buffer.from(arg, "base64").toString("utf8")));
	const env = new NodeExecutionEnv({ cwd: request.cwd ?? process.cwd() });
	switch (request.op) {
		case "ping":
			return write({ ok: true, value: "pong" });
		case "call": {
			if (!METHODS.has(request.method)) throw new Error(`Not an operation: ${request.method}`);
			// JSON has no undefined: an argument left out arrives as null.
			const args = request.args.map((arg) => (arg === null ? undefined : arg));
			return write(resultOf(await env[request.method](...args, context)));
		}
		case "open": {
			// Pi decides whether the path can be opened (a directory, a missing file, a symbolic link with noFollow); the
			// reader is then a hard link to the file, in the handles directory.
			const opened = await env.openBinaryReader(request.path, request.options ?? undefined, context);
			if (!opened.ok) return write(resultOf(opened));
			const info = await opened.value.info(context);
			await opened.value.close(context);
			if (!info.ok) return write(resultOf(info));
			await mkdir(request.handles, { recursive: true });
			const handle = join(request.handles, randomUUID());
			try {
				await link(await realpath(info.value.path), handle);
			} catch (error) {
				// Another file system, such as /tmp: the reader reads by path, without surviving a rename.
				if (error.code !== "EXDEV") throw error;
				return write({ ok: true, value: { handle: info.value.path, linked: false, info: info.value } });
			}
			return write({ ok: true, value: { handle, linked: true, info: info.value } });
		}
		case "info": {
			const reader = await env.openBinaryReader(request.handle, undefined, context);
			if (!reader.ok) return write(resultOf(reader));
			const info = await reader.value.info(context);
			await reader.value.close(context);
			return write(resultOf(info));
		}
		case "range": {
			const reader = await env.openBinaryReader(request.handle, undefined, context);
			if (!reader.ok) return write(resultOf(reader));
			const read = await reader.value.read(request.offset, request.length, context);
			await reader.value.close(context);
			return write(resultOf(read));
		}
		case "scan": {
			const reader = await env.openBinaryReader(request.handle, undefined, context);
			if (!reader.ok) return write(resultOf(reader));
			const scan = await reader.value.scanLines(request.options, context);
			await reader.value.close(context);
			return write(resultOf(scan));
		}
		case "close":
			if (request.linked) await rm(request.handle, { force: true });
			return write({ ok: true, value: null });
		case "lines": {
			const reader = await env.openTextLineReader(request.path, context);
			if (!reader.ok) return write(resultOf(reader));
			const lines = [];
			let done = false;
			try {
				for (let i = 0; i < request.skip + request.count; i += 1) {
					const line = await reader.value.readLine(context);
					if (!line.ok) return write(resultOf(line));
					if (line.value === undefined) {
						done = true;
						break;
					}
					if (i >= request.skip) lines.push(line.value);
				}
			} finally {
				await reader.value.close(context);
			}
			return write({ ok: true, value: { lines, done } });
		}
		case "dirnames": {
			const reader = await env.openDirReader(request.path, context);
			if (!reader.ok) return write(resultOf(reader));
			await reader.value.close(context);
			const path = (await env.absolutePath(request.path, context)).value;
			return write({ ok: true, value: { path, names: await readdir(path) } });
		}
		case "dirinfo": {
			// An entry removed since its name was read is skipped, as Pi's reader skips one removed during enumeration.
			const entries = [];
			for (const name of request.names) {
				const path = join(request.path, name);
				const info = await env.fileInfo(path, context);
				if (info.ok) entries.push(info.value);
				else if (info.error.code !== "not_found" && info.error.code !== "invalid") return write(resultOf(info));
			}
			return write({ ok: true, value: entries });
		}
		case "exec": {
			const options = {
				...request.options,
				onOutput: (text, _context, info) => write(info.skipped === undefined ? { chunk: text, stream: info.stream } : { chunk: text, stream: info.stream, skipped: info.skipped }),
			};
			return write({ done: resultOf(await env.exec(request.command, options, context)) });
		}
		case "watch": {
			// Pi's watchers don't keep a process running on their own, so this does until it's stopped or the watch fails.
			const stopped = new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
			const alive = setInterval(() => undefined, 60_000);
			const opened = await env.watch(
				request.targets,
				(change) => {
					if (!("error" in change)) return write({ change });
					write({ change: { error: errorOf(change.error) } });
					controller.abort(change.error);
				},
				context,
			);
			if (!opened.ok) {
				clearInterval(alive);
				return write({ done: resultOf(opened) });
			}
			write({ ready: opened.value.mode });
			await stopped;
			clearInterval(alive);
			await opened.value.close({ abortSignal: new AbortController().signal });
			return write({ done: { ok: true, value: null } });
		}
		default:
			throw new Error(`Not an operation: ${request.op}`);
	}
}

main().catch((error) => {
	write({ thrown: String(error?.stack ?? error) });
	process.exitCode = 1;
});
