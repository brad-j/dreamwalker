// One writer at a time. Pi Durable allows one process per storage: it hands out IDs from a counter it keeps in memory,
// so two writers would hand out the same ones. A Netlify Server runs one instance per deploy, but while a new deploy
// starts the old one is still up, and an old deploy's own URL can wake its instance at any time.
//
// The lease is one row: who holds it, the deploy it came from, and when it runs out. Taking it succeeds when it has
// run out, when this process already holds it, or when this process's deploy is the same or newer, so a new deploy
// takes over at once and an old deploy's URL can't take it back while the lease is kept up. Every transaction
// renews it first, holding the row's lock to its end, and fails if someone else took it: a process that lost the
// lease can't commit anything, so its Harness fails and the new holder carries on from the last commit.

import type { SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";

export const LEASE_SECONDS = 60;

export type Holder = {
	/** This process; a new one each start. */
	id: string;
	/**
	 * The deploy this process runs, compared as text: Netlify's deploy IDs start with their creation time in hex, so a
	 * newer deploy sorts after an older one. A Netlify Server has no `DEPLOY_ID` in its environment, so it's the ID the
	 * first request's context gave. Empty when there's no deploy, as under `netlify dev`.
	 */
	generation: string;
};

export class LeaseLost extends Error {}

type LeaseRow = { holder: string; generation: string; expires_in: number };

/** Takes the lease if it can. Returns undefined when it did, or who holds it and for how many seconds more. */
export async function takeLease(executor: SqliteExecutor, holder: Holder): Promise<LeaseRow | undefined> {
	const taken = await executor.get<{ holder: string }>(
		`INSERT INTO dreamwalker_lease (singleton, holder, generation, expires_at) VALUES (1, ?, ?, now() + make_interval(secs => ?))
		ON CONFLICT (singleton) DO UPDATE SET holder = excluded.holder, generation = excluded.generation, expires_at = excluded.expires_at
		WHERE dreamwalker_lease.holder = excluded.holder OR dreamwalker_lease.expires_at < now() OR dreamwalker_lease.generation <= excluded.generation
		RETURNING holder`,
		holder.id,
		holder.generation,
		LEASE_SECONDS,
	);
	if (taken !== undefined) return undefined;
	return executor.get<LeaseRow>("SELECT holder, generation, EXTRACT(EPOCH FROM expires_at - now())::float8 AS expires_in FROM dreamwalker_lease WHERE singleton = 1");
}

/** Renews the lease for the transaction it runs in, or throws LeaseLost if another process holds it now. */
export async function fence(executor: SqliteExecutor, holder: Holder): Promise<void> {
	const kept = await executor.get<{ holder: string }>("UPDATE dreamwalker_lease SET expires_at = now() + make_interval(secs => ?) WHERE singleton = 1 AND holder = ? RETURNING holder", LEASE_SECONDS, holder.id);
	if (kept === undefined) throw new LeaseLost("Another instance took the storage lease; this one can't write any more");
}

/** Gives the lease up, if this process still holds it, so the next instance needn't wait for it to run out. */
export async function releaseLease(executor: SqliteExecutor, holder: Holder): Promise<void> {
	await executor.run("DELETE FROM dreamwalker_lease WHERE singleton = 1 AND holder = ?", holder.id);
}
