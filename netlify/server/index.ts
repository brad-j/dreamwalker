// dreamwalker's Netlify Server. Top-level code runs once per instance, before it takes traffic. An instance sleeps
// after five minutes without a request and is replaced after eight hours, so nothing here may live only in memory:
// conversations are in Netlify Database, and the lease there keeps a second instance from writing at the same time.
//
// The storage opens on the first request, not here: Netlify Database's connection string, like the AI Gateway's
// credentials, is only in the environment while a request is being handled.

import { type Config, onShutdown } from "@netlify/server";
import { createApi } from "../../src/api.ts";
import { budgetSettingsFrom } from "../../src/budget.ts";
import { platformEnv, platformNames, Remembered } from "../../src/environment.ts";
import { memoryStorage, startInstance } from "../../src/instance.ts";
import { Credentials, modelFor, modelSettingsFrom } from "../../src/model.ts";
import { ntfyAdapter, ntfySettingsFrom } from "../../src/ntfy.ts";
import { openDatabaseStorage } from "../../src/storage/index.ts";

export const config: Config = { path: "/api/*" };

const memory = process.env.DREAMWALKER_STORAGE === "memory";
const databaseUrl = new Remembered("NETLIFY_DB_URL");
const connectionString = () => {
	const url = databaseUrl.current(platformEnv);
	if (url === undefined) throw new Error("NETLIFY_DB_URL hasn't been in the environment yet, at startup or in any request");
	return url;
};
const storage = memory ? memoryStorage : () => openDatabaseStorage({ connectionString });
const settings = modelSettingsFrom(process.env);
const credentials = new Credentials();
const ntfy = ntfySettingsFrom(process.env);
const owner = process.env.DREAMWALKER_OWNER || undefined;
const budget = budgetSettingsFrom(process.env);
const instance = startInstance(storage, modelFor(settings, credentials), {
	owner,
	budget,
	adapters: ntfy === undefined ? {} : { ntfy: ntfyAdapter(ntfy) },
});

// Closing the storage gives the lease up, so the next instance needn't wait for it to run out. The package's hook
// and the spec's exported function are both here until it's clear which the platform calls.
onShutdown(() => instance.close());
export const shutdown = () => instance.close();

const startedAt = new Date().toISOString();
const variablesAtStartup = platformNames();

export default createApi(instance, {
	token: process.env.DREAMWALKER_TOKEN || undefined,
	local: process.env.NETLIFY_DEV === "true",
	env: platformEnv,
	see: (read) => {
		databaseUrl.see(read);
		credentials.see(read);
	},
	credentials,
	describe: () => ({
		startedAt,
		deployId: platformEnv("DEPLOY_ID"),
		context: platformEnv("CONTEXT"),
		storageKind: memory ? "memory" : "Netlify Database",
		databaseUrlAgeSeconds: databaseUrl.age(),
		owner: owner ?? "the user (DREAMWALKER_OWNER isn't set)",
		timeZone: budget.timeZone,
		modelId: settings.provider === "faux" ? "faux" : settings.id,
		notifications: ntfy === undefined ? "none: NTFY_URL isn't set, so reminders go to the log" : "ntfy",
		variablesAtStartup,
	}),
});
