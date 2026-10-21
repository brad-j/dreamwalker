// dreamwalker's sandbox: a Netlify Sandbox, a named VM with a disk that persists, where the agent's commands and file
// tools run, never on the server. The SDK (plinthwick) finds its credentials in NETLIFY_SANDBOX_CONTEXT, which like
// the Gateway's and the database's is only in the environment while a request is being handled, so the newest one a
// request showed is kept and handed to the SDK, for tool calls made in a job or after a restart.
//
// Sandboxes are experimental on Netlify. When one can't be reached, the tool call fails with what went wrong, and
// nothing else in dreamwalker depends on it.
import { getSandbox, type NetworkPolicy, type Sandbox } from "plinthwick";
import { type ReadEnv, Remembered } from "./environment.ts";
import type { Box } from "./sandbox-env.ts";
import { object, optional, parseJson, string } from "./parse.ts";

export const SANDBOX_CONTEXT = "NETLIFY_SANDBOX_CONTEXT";

const Context = object({ apiURL: optional(string), siteID: string, token: string });

/** The SDK's credentials as the newest request showed them. */
export class SandboxCredentials {
	#seen = new Remembered(SANDBOX_CONTEXT);

	see(read: ReadEnv) {
		this.#seen.see(read);
	}

	/** The site, token and API address to reach this site's sandboxes with, or undefined before any request showed them. */
	current(read: ReadEnv): { siteID: string; token: string; apiURL?: string } | undefined {
		const encoded = this.#seen.current(read);
		if (encoded === undefined) return undefined;
		const context = parseJson(Buffer.from(encoded, "base64").toString("utf8"), Context, SANDBOX_CONTEXT);
		return context.apiURL === undefined ? { siteID: context.siteID, token: context.token } : context;
	}

	age(): number | undefined {
		return this.#seen.age();
	}
}

/**
 * The worker's sandbox reaches the open internet. The worker holds none of the owner's notes or conversation, only its
 * task (worker.ts), so a page that tells it to send something out finds nothing of the owner's to send, and no secret
 * of the server's is in the sandbox. The main agent has no sandbox at all.
 */
export const WORKER_NETWORK: NetworkPolicy = { egress: "allow_all" };

/** Any other sandbox, as the probe makes one: no network. */
export const CLOSED_NETWORK: NetworkPolicy = { egress: "deny_all" };

/**
 * The worker's sandbox. A sandbox keeps the policy it was made with, and the SDK doesn't compare policies when it finds
 * a sandbox by name, so a changed policy needs a name never used before; the probe shows what the network reaches.
 */
export const WORKER_SANDBOX = "dreamwalker-worker";

/** Where things are in the worker's sandbox. */
export type WorkerLayout = {
	/** The home directory, cleared of anything but `keep` once no task is running. */
	home: string;
	/** Each task's directory is made in here. */
	work: string;
	/** Names in `home` that stay: the helper's install, the server's check, `work`. */
	keep: readonly string[];
	/** Where the helper keeps reader links, each holding a file's contents alive until it's removed. */
	handles: string;
	/** Temporary directories, cleared once no task is running. */
	tmp: readonly string[];
};

export const WORKER_LAYOUT: WorkerLayout = {
	home: "/root",
	work: "/root/work",
	keep: [".dreamwalker", ".dreamwalker-check", "work"],
	handles: "/root/.dreamwalker/handles",
	tmp: ["/tmp", "/var/tmp"],
};

// Removes the task's directory; then, if no other task's directory is left, so no worker is mid-task, everything else a
// task could have left: temporary files, reader links, and anything in the home directory but what's kept. The
// directories are the count of running tasks, so it holds across restarts.
const CLEAR = `
work="$1"; dir="$2"; home="$3"; handles="$4"; keep="$5"; shift 5
rm -rf "$work/$dir"
[ -z "$(ls -A "$work" 2>/dev/null)" ] || exit 0
for tmp in "$@"; do find "$tmp" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null; done
rm -rf "$handles"
for entry in "$home"/* "$home"/.[!.]* "$home"/..?*; do
	[ -e "$entry" ] || continue
	case " $keep " in *" \${entry##*/} "*) continue ;; esac
	rm -rf "$entry"
done
`;

/** Clears what the worker's task `dir` left in the sandbox (above). */
export async function clearTask(box: Box, layout: WorkerLayout, dir: string): Promise<void> {
	if (!/^[a-z0-9-]+$/.test(dir)) throw new Error(`Not a task directory: ${dir}`);
	const cleared = await box.run(["sh", "-c", CLEAR, "clear", layout.work, dir, layout.home, layout.handles, layout.keep.join(" "), ...layout.tmp]);
	if (cleared.exitCode !== 0) throw new Error(`Couldn't clear the task's files: ${cleared.stderr.trim()}`);
}

/** The sandbox called `name`, made with `network` the first time, and as it was made after that. */
export async function sandboxFor(credentials: SandboxCredentials, read: ReadEnv, name: string, network: NetworkPolicy): Promise<Sandbox> {
	const seen = credentials.current(read);
	if (seen === undefined) throw new Error("No sandbox credentials have been seen yet: Netlify Sandboxes may not be on for this site.");
	return getSandbox(name, { ...seen, network });
}

/** What a sandbox is: its size and the programs a file environment can be built on. For the status route. */
export async function probe(sandbox: Sandbox): Promise<Record<string, string | number>> {
	const run = async (command: string) => {
		const result = await sandbox.commands.run(["sh", "-c", command]);
		return `${result.stdout}${result.stderr}`.trim() || `(exit ${result.exitCode})`;
	};
	return {
		id: sandbox.id,
		memoryMB: sandbox.memoryMB,
		vcpus: sandbox.vcpus,
		diskSizeMB: sandbox.diskSizeMB,
		system: await run("uname -sm; cat /etc/os-release 2>/dev/null | head -2"),
		user: await run("id; pwd; echo $HOME"),
		programs: await run("for p in sh bash dash busybox python3 node git stat find base64 head tail wc mktemp realpath inotifywait fd rg; do printf '%s=%s ' $p \"$(command -v $p || echo -)\"; done"),
		network: await run("(command -v curl >/dev/null && curl -sS -m 5 -o /dev/null -w '%{http_code}' https://example.com) 2>&1 || echo no-curl"),
		// Only the names: whether the platform puts anything in a command's environment that the agent shouldn't see.
		environment: await run("env | cut -d= -f1 | sort | tr '\\n' ' '"),
	};
}
