// Pi Durable's storage on Netlify Database: the Postgres facade, held by this process's lease.

import { randomUUID } from "node:crypto";
import type { Storage } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { fence, type Holder, LEASE_SECONDS, releaseLease, takeLease } from "./lease.ts";
import { PostgresDatabase } from "./postgres.ts";

/** Pi Durable's tables are prefixed, leaving the rest of the database to dreamwalker's own. */
export const TABLE_PREFIX = "pi_";

export type DatabaseStorageOptions = {
	connectionString: () => string;
	holder?: Holder;
	/** How long to wait for another instance's lease before giving up. Default: until it would have run out. */
	waitMs?: number;
	/** Between attempts to take the lease. */
	pollMs?: number;
};

/** A new holder for this process, from the deploy it runs: the ID a request's context gave, or `DEPLOY_ID`. */
export function holderFor(deployId: string | undefined): Holder {
	return { id: randomUUID(), generation: deployId ?? process.env.DEPLOY_ID ?? "" };
}

/**
 * Takes the lease, waiting while another instance holds it, then opens Pi Durable's storage. A timer keeps the lease
 * while nothing commits; closing the storage gives it up.
 */
export async function openDatabaseStorage(options: DatabaseStorageOptions): Promise<Storage> {
	const holder = options.holder ?? holderFor(undefined);
	const database = new PostgresDatabase({ connectionString: options.connectionString, beforeClose: (executor) => releaseLease(executor, holder) });
	const deadline = Date.now() + (options.waitMs ?? (LEASE_SECONDS + 5) * 1000);
	while (true) {
		const holding = await database.transaction((executor) => takeLease(executor, holder)).catch(async (error) => {
			await database.close();
			// 42P01: the lease's table doesn't exist, so neither do the others.
			if (error instanceof Error && "code" in error && error.code === "42P01") throw new Error("Netlify Database has none of dreamwalker's tables. Apply the migrations: `netlify database migrations apply` locally; a deploy applies them itself.", { cause: error });
			throw error;
		});
		if (holding === undefined) break;
		if (Date.now() >= deadline) {
			await database.close();
			throw new Error(`Another instance (deploy ${holding.generation || "none"}) holds the storage lease for ${Math.ceil(holding.expires_in)}s more`);
		}
		await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000));
	}
	database.guardWith((executor) => fence(executor, holder));
	const storage = await SqliteStorage.open(database, { prefix: TABLE_PREFIX });
	// A failed renewal is left for the next commit to find: its own fence fails the same way and fails the Harness.
	const renew = setInterval(() => void database.transaction(async () => undefined).catch(() => undefined), (LEASE_SECONDS * 1000) / 3);
	renew.unref();
	const close = storage.close.bind(storage);
	storage.close = (context) => {
		clearInterval(renew);
		return close(context);
	};
	return storage;
}
