// What the platform puts in the environment, and when. In a Netlify Server some variables, the AI Gateway's
// credentials and Netlify Database's connection string among them, exist only while a request is being handled:
// in `Netlify.env`, which follows the request, or in `process.env` during it. Work that runs outside a request
// (reminders, jobs, a reconnect, a run resumed after a restart) uses what the last request showed.

/** A variable as the platform shows it right now. */
export type ReadEnv = (name: string) => string | undefined;

type NetlifyGlobal = { env: { get(name: string): string | undefined; toObject?(): Record<string, string> } };

function netlifyGlobal(): NetlifyGlobal | undefined {
	// SAFETY: the Netlify runtimes define `Netlify` with this shape; elsewhere it's absent.
	return (globalThis as { Netlify?: NetlifyGlobal }).Netlify;
}

/** Netlify's per-request environment first, then the process's. */
export const platformEnv: ReadEnv = (name) => netlifyGlobal()?.env.get(name) || process.env[name] || undefined;

/** A reader over a plain object, for tests and local runs. */
export const envFrom =
	(env: Partial<Record<string, string>>): ReadEnv =>
	(name) =>
		env[name] || undefined;

/** Names of variables in sight, by where they were seen. */
export type VariableNames = { process: string[]; netlify: string[] };

/** The names, never the values, of the platform's variables in sight now: what the status route reports. */
export function platformNames(): VariableNames {
	const interesting = (name: string) => /^(NETLIFY_|ANTHROPIC_|DEPLOY_|CONTEXT$|SITE_|URL$)/.test(name);
	return {
		process: Object.keys(process.env).filter(interesting).sort(),
		netlify: Object.keys(netlifyGlobal()?.env.toObject?.() ?? {}).filter(interesting).sort(),
	};
}

/** The newest value seen of one variable. */
export class Remembered {
	#name: string;
	#value: string | undefined;
	#at = 0;
	#now: () => number;

	constructor(name: string, now: () => number = Date.now) {
		this.#name = name;
		this.#now = now;
	}

	/** Keeps the variable's value if `read` shows one now. */
	see(read: ReadEnv) {
		const value = read(this.#name);
		if (value === undefined) return;
		this.#value = value;
		this.#at = this.#now();
	}

	/** The newest value, looking at `read` first. */
	current(read: ReadEnv): string | undefined {
		this.see(read);
		return this.#value;
	}

	/** Seconds since it was last seen, or undefined if it never was. */
	age(): number | undefined {
		return this.#value === undefined ? undefined : Math.round((this.#now() - this.#at) / 1000);
	}
}
