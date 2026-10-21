// dreamwalker's Netlify Server. Top-level code runs once per instance, before it takes traffic. An instance sleeps
// after five minutes without a request and is replaced after eight hours, so nothing here may live only in memory:
// conversations are in Netlify Database, and the lease there keeps a second instance from writing at the same time.
//
// The storage opens on the first request, not here: Netlify Database's connection string, like the AI Gateway's
// credentials, is only in the environment while a request is being handled.

import { type Config, getContext, onShutdown } from "@netlify/server";
import { createApi } from "../../src/api.ts";
import { budgetSettingsFrom } from "../../src/budget.ts";
import { platformEnv, Remembered } from "../../src/environment.ts";
import { memoryStorage, startInstance } from "../../src/instance.ts";
import { Credentials, modelFor, modelSettingsFrom } from "../../src/model.ts";
import { netlifySettingsFrom } from "../../src/netlify.ts";
import { ntfyAdapter, ntfySettingsFrom } from "../../src/ntfy.ts";
import { claudeSearch } from "../../src/search.ts";
import { CLOSED_NETWORK, clearTask, probe, SandboxCredentials, sandboxFor, WORKER_LAYOUT, WORKER_NETWORK, WORKER_SANDBOX } from "../../src/sandbox.ts";
import { isTailscaleSandbox, tailscaleCheck, tailscaleNetwork } from "../../src/lan.ts";
import { sandboxCheck } from "../../src/sandbox-check.ts";
import { boxOf, SandboxEnv } from "../../src/sandbox-env.ts";
import { holderFor, openDatabaseStorage } from "../../src/storage/index.ts";
import { postgresHistory } from "../../src/history.ts";

export const config: Config = { path: "/api/*" };

const memory = process.env.DREAMWALKER_STORAGE === "memory";
const databaseUrl = new Remembered("NETLIFY_DB_URL");
const connectionString = () => {
	const url = databaseUrl.current(platformEnv);
	if (url === undefined) throw new Error("NETLIFY_DB_URL hasn't been in the environment yet, at startup or in any request");
	return url;
};
/** The deploy the request being handled reached, as its context says, or undefined where there's no context. */
const requestDeploy = () => {
	try {
		const { id, context, published } = getContext().deploy;
		return { id, context, published };
	} catch {
		return undefined;
	}
};

// The deploy this instance runs, from the first request's context, since DEPLOY_ID isn't in a Server's environment. The
// lease ranks instances by it, and the storage only opens once a request has been seen.
let deployId: string | undefined;
const storage = memory ? memoryStorage : () => openDatabaseStorage({ connectionString, holder: holderFor(deployId) });
const settings = modelSettingsFrom(process.env);
const credentials = new Credentials();
const sandboxCredentials = new SandboxCredentials();
const ntfy = ntfySettingsFrom(process.env);
const owner = process.env.DREAMWALKER_OWNER || undefined;
const budget = budgetSettingsFrom(process.env);
const chosen = modelFor(settings, credentials);
// Search runs on Claude too, through the same credentials; there's none on the faux model.
const search =
	settings.provider === "faux" ? undefined : claudeSearch(() => credentials.current(platformEnv), settings.id, chosen.models.getModel("anthropic", settings.id)?.cost);
// The worker's computer is a Netlify Sandbox, reached with the credentials the newest request showed.
const networkFor = (name: string) => (name === WORKER_SANDBOX ? WORKER_NETWORK : isTailscaleSandbox(name) ? tailscaleNetwork(name) : CLOSED_NETWORK);
const workerSandbox = {
	id: `sandbox:${WORKER_SANDBOX}`,
	root: "/root/.dreamwalker",
	box: async () => boxOf(await sandboxFor(sandboxCredentials, platformEnv, WORKER_SANDBOX, WORKER_NETWORK)),
};
// Each task in a directory of its own, with its own home and temporary files, all cleared when it ends.
const workspace = {
	env: (dir: string) => new SandboxEnv({ ...workerSandbox, cwd: `${WORKER_LAYOUT.work}/${dir}`, ownHome: true }),
	clear: async (dir: string) => clearTask(await workerSandbox.box(), WORKER_LAYOUT, dir),
};
// The server's secrets as they stand, redacted from every tool result: the owner's token, ntfy's, the Netlify tools'
// token, and what only requests show (the Gateway's key, the database's address and password, the sandboxes' token).
const secrets = () => {
	const named = (name: string, value: string | undefined) => (value === undefined || value === "" ? [] : [{ name, value }]);
	const db = databaseUrl.current(platformEnv);
	return [
		...named("DREAMWALKER_TOKEN", process.env.DREAMWALKER_TOKEN),
		...named("NTFY_TOKEN", process.env.NTFY_TOKEN),
		...named("NTFY_URL", process.env.NTFY_URL),
		...Object.entries(process.env).flatMap(([name, value]) => (name.startsWith("NETLIFY_AGENT_PAT") ? named(name, value) : [])),
		...named("ANTHROPIC_API_KEY", credentials.current(platformEnv)?.apiKey),
		...named("NETLIFY_DB_URL", db),
		...named("NETLIFY_DB_PASSWORD", db === undefined ? undefined : decodeURIComponent(URL.parse(db)?.password ?? "")),
		...named("NETLIFY_SANDBOX_TOKEN", sandboxToken()),
	];
};
/** The sandboxes' token, or nothing when their context hasn't been seen or doesn't read. */
const sandboxToken = () => {
	try {
		return sandboxCredentials.current(platformEnv)?.token;
	} catch {
		return undefined;
	}
};
const instance = startInstance(storage, chosen, {
	secrets,
	history: memory ? undefined : postgresHistory(connectionString),
	owner,
	search,
	workspace,
	netlify: { settings: netlifySettingsFrom(process.env) },
	budget,
	adapters: ntfy === undefined ? {} : { ntfy: ntfyAdapter(ntfy) },
});

// Closing the storage gives the lease up, so the next instance needn't wait for it to run out. The package's hook
// and the spec's exported function are both here until it's clear which the platform calls.
onShutdown(() => instance.close());
export const shutdown = () => instance.close();

const startedAt = new Date().toISOString();

export default createApi(instance, {
	token: process.env.DREAMWALKER_TOKEN || undefined,
	local: process.env.NETLIFY_DEV === "true",
	env: platformEnv,
	see: (read) => {
		deployId ??= requestDeploy()?.id;
		databaseUrl.see(read);
		credentials.see(read);
		sandboxCredentials.see(read);
	},
	probe: async (name) => probe(await sandboxFor(sandboxCredentials, platformEnv, name, networkFor(name))),
	sandboxCheck: sandboxCheck({ ...workerSandbox, scratch: "/root/.dreamwalker-check" }),
	tailscaleCheck: tailscaleCheck(async (name) => boxOf(await sandboxFor(sandboxCredentials, platformEnv, name, tailscaleNetwork(name)))),
	// Finding a sandbox by name makes it if there's none, so deleting one that's gone makes and deletes it.
	deleteSandbox: async (name) => (await sandboxFor(sandboxCredentials, platformEnv, name, networkFor(name))).delete(),
	credentials,
	deploy: requestDeploy,
	describe: () => ({
		startedAt,
		deployId,
		storageKind: memory ? "memory" : "Netlify Database",
		databaseUrlAgeSeconds: databaseUrl.age(),
		sandboxCredentialsAgeSeconds: sandboxCredentials.age(),
		owner: owner ?? "the user (DREAMWALKER_OWNER isn't set)",
		timeZone: budget.timeZone,
		modelId: settings.provider === "faux" ? "faux" : settings.id,
		notifications: ntfy === undefined ? "none: NTFY_URL isn't set, so reminders go to the log" : "ntfy",
	}),
});
