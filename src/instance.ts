// The host for the life of one server instance. It opens on first use rather than at startup, since some of what
// it needs (Netlify Database's connection string) is only in the environment while a request is being handled. A
// failed open is tried again on the next use. A storage failure ends Pi Durable's Harness; this opens a new one,
// which resumes from the last commit, unless the failure was another instance taking the lease, which means this
// one has been replaced and should only say so.

import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { type Host, type HostOptions, openHost } from "./host.ts";
import type { Chosen } from "./model.ts";
import { LeaseLost } from "./storage/lease.ts";

export type Instance = {
	/** The open host, opening it if need be; undefined once another instance has taken over. Rejects if it can't open. */
	host: () => Promise<Host | undefined>;
	close: () => Promise<void>;
};

/** Whether `cause`, or anything that caused it, is a lost lease. */
const replacedBy = (cause: unknown) => {
	for (let e = cause; e instanceof Error; e = e.cause) if (e instanceof LeaseLost) return true;
	return false;
};

export function startInstance(openStorage: () => Promise<Storage>, chosen: Chosen, options: HostOptions = {}): Instance {
	let closing = false;
	let replaced = false;
	let current: Promise<Host> | undefined;

	const open = (): Promise<Host> => {
		const opening = openStorage().then((storage) => openHost(storage, chosen, options));
		opening.then(
			(host) =>
				host.harness.closed.then((end) => {
					if (end.reason !== "failed" || closing) return;
					if (replacedBy(end.error)) {
						console.error("[instance] another instance took the storage lease; this one has stopped");
						replaced = true;
						return;
					}
					console.error("[instance] storage failed, reopening:", end.error);
					current = open();
				}),
			(error) => {
				console.error("[instance] couldn't open:", error);
				// The next use tries again.
				if (current === opening) current = undefined;
			},
		);
		return opening;
	};

	let closed: Promise<void> | undefined;
	return {
		host: async () => {
			if (replaced) return undefined;
			if (closing) throw new Error("This instance is shutting down");
			current ??= open();
			return current;
		},
		// Once, however many ways the platform asks: an onShutdown hook and an exported shutdown both call it.
		close: () =>
			(closed ??= (async () => {
				closing = true;
				const host = await current?.catch(() => undefined);
				await host?.close();
			})()),
	};
}

/** Memory storage, for `DREAMWALKER_STORAGE=memory`: nothing survives a restart. */
export const memoryStorage = async (): Promise<Storage> => new MemoryStorage();
