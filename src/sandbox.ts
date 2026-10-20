// dreamwalker's sandbox: a Netlify Sandbox, a named VM with a disk that persists, where the agent's commands and file
// tools run, never on the server. The SDK (plinthwick) finds its credentials in NETLIFY_SANDBOX_CONTEXT, which like
// the Gateway's and the database's is only in the environment while a request is being handled, so the newest one a
// request showed is kept and handed to the SDK, for tool calls made in a job or after a restart.
//
// Sandboxes are experimental on Netlify. When one can't be reached, the tool call fails with what went wrong, and
// nothing else in dreamwalker depends on it.
import { getSandbox, type NetworkPolicy, type Sandbox } from "plinthwick";
import { type ReadEnv, Remembered } from "./environment.ts";
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

/** What the agent's sandbox may reach: nothing, as gaidin's shell has no network. fetch_url is the way out, and it asks. */
export const AGENT_NETWORK: NetworkPolicy = { egress: "deny_all" };

/** The sandbox called `name`, made with `network` the first time. */
export async function sandboxFor(credentials: SandboxCredentials, read: ReadEnv, name: string, network: NetworkPolicy = AGENT_NETWORK): Promise<Sandbox> {
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
	};
}
