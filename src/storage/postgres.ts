// Pi Durable's SQLite storage, run on Postgres. SqliteStorage talks to a small async facade (exec, run, get, all,
// transaction, close); this is that facade over one pg connection, so Pi Durable's own storage code, tested by its
// authors, does the work, and an upgrade brings its fixes. What differs from SQLite is translated here:
//
// - `?` placeholders become `$1`, `$2`, ...; `INSERT OR IGNORE` becomes `ON CONFLICT DO NOTHING`. The rest of its
//   SQL (`ON CONFLICT(id) DO UPDATE ... excluded`, partial indexes, LIMIT) is the same in both.
// - BIGINT columns come back as numbers, as SQLite's INTEGER does, instead of pg's strings.
// - Schema changes are refused. The schema comes from netlify/database/migrations, applied by the deploy; Pi Durable's
//   startup migration finds it at its current version and asks for nothing.
//
// Everything runs on one connection, one operation at a time, which is what the facade promises: other work waits
// while a transaction runs. A dropped connection is reopened, and work that hadn't reached COMMIT is tried again once.

import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import pg from "pg";

/** Runs inside every transaction, right after BEGIN, on the same connection: the lease's fence. */
export type TransactionGuard = (executor: SqliteExecutor) => Promise<void>;

const parsers: pg.CustomTypesConfig = {
	getTypeParser: (oid: number, format?: "text" | "binary") => (oid === pg.types.builtins.INT8 ? Number : pg.types.getTypeParser(oid, format)),
};

const translated = new Map<string, string>();

/** `sql` in Postgres's dialect. Pi Durable's SQL has no `?` inside string literals, but they're skipped anyway. */
export function toPostgres(sql: string): string {
	const known = translated.get(sql);
	if (known !== undefined) return known;
	let out = "";
	let n = 0;
	let quoted = false;
	for (const c of sql) {
		if (c === "'") quoted = !quoted;
		out += c === "?" && !quoted ? `$${++n}` : c;
	}
	if (/^\s*INSERT OR IGNORE INTO/i.test(out)) out = `${out.replace(/^\s*INSERT OR IGNORE INTO/i, "INSERT INTO")} ON CONFLICT DO NOTHING`;
	translated.set(sql, out);
	return out;
}

/** Whether `cause` means the connection is gone, rather than that the statement was wrong. */
export function isConnectionError(cause: Error): boolean {
	const code = "code" in cause ? String(cause.code) : "";
	return code.startsWith("08") || code === "57P01" || code === "57P02" || code === "57P03" || ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT"].includes(code) || /Connection terminated|not queryable|Client was closed/i.test(cause.message);
}

/** COMMIT was sent and the connection failed before it answered: the transaction may or may not be stored. */
export class CommitUnknown extends Error {}

const asError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));

class Executor implements SqliteExecutor {
	#client: pg.Client;
	#live = true;

	constructor(client: pg.Client) {
		this.#client = client;
	}

	expire() {
		this.#live = false;
	}

	async #query(sql: string, params: SqliteValue[]) {
		if (!this.#live) throw new Error("This transaction handle has expired");
		// pg sends bigints as text and Uint8Arrays as bytea itself.
		return this.#client.query(toPostgres(sql), params);
	}

	async exec(sql: string): Promise<void> {
		if (!this.#live) throw new Error("This transaction handle has expired");
		await refuseSchemaChange(this.#client, sql);
	}

	async run(sql: string, ...params: SqliteValue[]): Promise<void> {
		await this.#query(sql, params);
	}

	async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		// SAFETY: the caller names the columns its SQL selects; T describes them.
		return (await this.#query(sql, params)).rows[0] as T | undefined;
	}

	async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		// SAFETY: as in get.
		return (await this.#query(sql, params)).rows as T[];
	}
}

/**
 * Pi Durable only calls exec for its migrations. The one statement it always runs makes its schema-version table if
 * it's missing, which the migration already did; anything else is a schema change Pi Durable wants, which has to
 * come from a migration file.
 */
async function refuseSchemaChange(client: pg.Client, sql: string) {
	const bootstrap = /^\s*CREATE TABLE IF NOT EXISTS (\w+)\s*\(/i.exec(sql);
	if (bootstrap !== null) {
		const exists = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [bootstrap[1]]);
		if (exists.rows[0]?.present === true) return;
		throw new Error(`Table ${bootstrap[1]} is missing. Apply the migrations in netlify/database/migrations (locally: netlify database migrations apply).`);
	}
	const first = sql.trim().split("\n")[0];
	throw new Error(`Pi Durable asked for a schema change the migrations don't have (${first} ...). Add its next schema version as a migration in netlify/database/migrations.`);
}

export type PostgresOptions = {
	/** Read on every connect, so a rotated password is picked up. */
	connectionString: () => string;
	guard?: TransactionGuard;
	/** Runs on the connection before it closes, after every other operation: the lease's release. */
	beforeClose?: (executor: SqliteExecutor) => Promise<void>;
};

export class PostgresDatabase implements SqliteDatabase {
	#options: PostgresOptions;
	#client: pg.Client | undefined;
	#broken = false;
	#tail: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(options: PostgresOptions) {
		this.#options = options;
	}

	/** Replaces the transaction guard; the lease sets it once it's held. */
	guardWith(guard: TransactionGuard) {
		this.#options = { ...this.#options, guard };
	}

	async #connection(): Promise<pg.Client> {
		if (this.#client !== undefined && !this.#broken) return this.#client;
		await this.#client?.end().catch(() => undefined);
		const client = new pg.Client({ connectionString: this.#options.connectionString(), types: parsers });
		client.on("error", () => {
			this.#broken = true;
		});
		await client.connect();
		this.#client = client;
		this.#broken = false;
		return client;
	}

	/** Runs `work` after everything queued before it; a failure doesn't stop what's queued after. */
	#queued<T>(work: () => Promise<T>): Promise<T> {
		if (this.#closed) return Promise.reject(new Error("The database is closed"));
		const result = this.#tail.then(work);
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** Runs `attempt` on a live connection, once more on a fresh one if the connection dropped before it finished. */
	async #withRetry<T>(attempt: (client: pg.Client) => Promise<T>): Promise<T> {
		try {
			return await attempt(await this.#connection());
		} catch (error) {
			const cause = asError(error);
			if (cause instanceof CommitUnknown || (!isConnectionError(cause) && !this.#broken)) throw cause;
			this.#broken = true;
			return attempt(await this.#connection());
		}
	}

	#once<T>(use: (executor: Executor) => Promise<T>): Promise<T> {
		return this.#queued(() =>
			this.#withRetry(async (client) => {
				const executor = new Executor(client);
				try {
					return await use(executor);
				} finally {
					executor.expire();
				}
			}),
		);
	}

	exec(sql: string): Promise<void> {
		return this.#once((e) => e.exec(sql));
	}

	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.#once((e) => e.run(sql, ...params));
	}

	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.#once((e) => e.get<T>(sql, ...params));
	}

	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.#once((e) => e.all<T>(sql, ...params));
	}

	/**
	 * BEGIN, the guard, the callback and COMMIT on one connection, nothing else in between. A dropped connection before
	 * COMMIT reruns the whole callback on a new one, since nothing was stored. One dropped during COMMIT can't be
	 * retried: whether it was stored is unknown, so it fails and the Harness fails with it.
	 */
	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.#queued(() =>
			this.#withRetry(async (client) => {
				const executor = new Executor(client);
				await client.query("BEGIN");
				let result: T;
				try {
					await this.#options.guard?.(executor);
					result = await callback(executor);
				} catch (error) {
					executor.expire();
					const cause = asError(error);
					if (this.#broken || isConnectionError(cause)) throw cause;
					try {
						await client.query("ROLLBACK");
					} catch (rollback) {
						throw new AggregateError([cause, rollback], "The transaction failed and couldn't be rolled back");
					}
					throw cause;
				}
				executor.expire();
				try {
					await client.query("COMMIT");
				} catch (error) {
					throw new CommitUnknown("COMMIT failed, so whether the transaction was stored is unknown", { cause: error });
				}
				return result;
			}),
		);
	}

	close(): Promise<void> {
		const closing = this.#queued(async () => {
			if (this.#options.beforeClose !== undefined && this.#client !== undefined && !this.#broken) {
				const executor = new Executor(this.#client);
				await this.#options.beforeClose(executor).catch((error) => console.error("[storage] before close:", error));
				executor.expire();
			}
			await this.#client?.end().catch(() => undefined);
			this.#client = undefined;
		});
		this.#closed = true;
		return closing;
	}
}
