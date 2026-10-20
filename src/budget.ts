// The spend guard, from gaidin. Pi Durable keeps each conversation's model and tool costs; this totals them, keeps a
// baseline at the start of each local day and month, and refuses new model requests once the day's or the month's
// spend reaches its limit. Requests are refused by the model lookup the Harness makes before each one: with no model,
// the run ends as unanswered, without retrying. The owner can allow more for the day.
//
// The total is refreshed after every model response, so the request that crosses a limit still finishes. Costs are
// the model catalog's prices, which are what the AI Gateway bills too, before its conversion to credits. Netlify
// Database's compute isn't counted here.
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { defineDoc, defineExtension, GenerationTask, type Harness, hook } from "@earendil-works/pi-durable";

/** Dollars a local day and a calendar month; 0 is no limit. */
export type Limits = { daily: number; monthly: number };

export type BudgetSettings = { limits: Limits; timeZone: string };

const dollars = (name: string, value: string | undefined, fallback: number) => {
	if (value === undefined || value === "") return fallback;
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a dollar amount of 0 or more, not ${JSON.stringify(value)}`);
	return n;
};

/**
 * The budget from the environment: `DREAMWALKER_BUDGET_DAILY` (default $5), `DREAMWALKER_BUDGET_MONTHLY` (default $50)
 * and `DREAMWALKER_TZ` for where days start (default UTC).
 */
export function budgetSettingsFrom(env: NodeJS.ProcessEnv): BudgetSettings {
	const timeZone = env.DREAMWALKER_TZ || "UTC";
	// Throws on a zone Intl doesn't know.
	new Intl.DateTimeFormat("en-CA", { timeZone });
	return {
		limits: { daily: dollars("DREAMWALKER_BUDGET_DAILY", env.DREAMWALKER_BUDGET_DAILY, 5), monthly: dollars("DREAMWALKER_BUDGET_MONTHLY", env.DREAMWALKER_BUDGET_MONTHLY, 50) },
		timeZone,
	};
}

export const Budget = defineDoc<{
	day: string;
	dayStart: number;
	month: string;
	monthStart: number;
	/** Extra dollars the owner allowed, by day. */
	extra: Record<string, number>;
	/** The day the owner was last told about 80% and about the limit. */
	warned?: string;
	stopped?: string;
}>({
	kind: "dreamwalker.budget",
	version: 1,
	scope: "session",
	initial: () => ({ day: "", dayStart: 0, month: "", monthStart: 0, extra: {} }),
});

export type BudgetStatus = {
	today: number;
	month: number;
	dailyLimit: number;
	monthlyLimit: number;
	stopped: boolean;
	reason?: string;
};

/** Total cost so far across every conversation, in dollars. */
export async function totalSpend(harness: Harness): Promise<number> {
	const usage = await harness.usage(background);
	return [...Object.values(usage.models), ...Object.values(usage.tools)].reduce((sum, u) => sum + u.cost.total, 0);
}

/** The local day and month in `timeZone`. */
export function localDay(timeZone: string, ms = Date.now()) {
	const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
	return { day, month: day.slice(0, 7) };
}

const money = (amount: number) => `$${amount.toFixed(2)}`;

export function createBudget(options: {
	settings: BudgetSettings;
	/** Tells the owner, once a day, about 80% and about reaching a limit. */
	notify: (text: string) => Promise<void>;
	/** Defaults to the Pi Durable totals. */
	spend?: (harness: Harness) => Promise<number>;
}) {
	const { limits, timeZone } = options.settings;
	const spend = options.spend ?? totalSpend;
	let harness: Harness | undefined;
	let status: BudgetStatus = { today: 0, month: 0, dailyLimit: limits.daily, monthlyLimit: limits.monthly, stopped: false };
	let statusDay = "";
	let refreshing: Promise<BudgetStatus> | undefined;
	let closed = false;

	async function compute(): Promise<BudgetStatus> {
		const h = harness!;
		const root = await h.root(background);
		const total = await spend(h);
		const { day, month } = localDay(timeZone);
		const { state, warn } = await root.commit(async (tx) => {
			const doc = await tx.doc(Budget);
			// A new day or month starts its count from here.
			if (doc.day !== day) {
				doc.day = day;
				doc.dayStart = total;
				for (const key of Object.keys(doc.extra)) if (key < day) delete doc.extra[key];
			}
			if (doc.month !== month) {
				doc.month = month;
				doc.monthStart = total;
			}
			const today = total - doc.dayStart;
			const thisMonth = total - doc.monthStart;
			const dailyLimit = limits.daily + (doc.extra[day] ?? 0);
			const overDay = limits.daily > 0 && today >= dailyLimit;
			const overMonth = limits.monthly > 0 && thisMonth >= limits.monthly;
			const reason = overMonth
				? `This month's spend is ${money(thisMonth)}, at the monthly limit of ${money(limits.monthly)}.`
				: overDay
					? `Today's spend is ${money(today)}, at the daily limit of ${money(dailyLimit)}.`
					: undefined;
			let warn: string | undefined;
			if (reason !== undefined && doc.stopped !== day) {
				doc.stopped = day;
				warn = `dreamwalker has stopped making model requests. ${reason} Allow more for today, or it starts again ${overMonth ? "next month" : "tomorrow"}.`;
			} else if (reason === undefined && limits.daily > 0 && today >= dailyLimit * 0.8 && doc.warned !== day) {
				doc.warned = day;
				warn = `dreamwalker has spent ${money(today)} today, 80% of the daily limit of ${money(dailyLimit)}.`;
			}
			const next: BudgetStatus = { today, month: thisMonth, dailyLimit, monthlyLimit: limits.monthly, stopped: reason !== undefined };
			if (reason !== undefined) next.reason = reason;
			return { state: next, warn };
		}, background);
		status = state;
		statusDay = day;
		if (warn !== undefined) options.notify(warn).catch((error) => console.error("[budget]", error));
		return state;
	}

	function refresh(): Promise<BudgetStatus> {
		if (harness === undefined || closed) return Promise.resolve(status);
		// One at a time; a refresh asked for during one waits for it, then runs again. One the shutdown cut off ends with
		// the last status, since nothing is left to use it.
		const next = (refreshing ?? Promise.resolve())
			.catch(() => {})
			.then(compute)
			.catch((error) => {
				if (closed) return status;
				throw error;
			});
		refreshing = next;
		return next;
	}

	/** Why requests are refused right now, or nothing. A new day clears a daily stop. */
	function blocked(): string | undefined {
		if (!status.stopped) return undefined;
		if (statusDay !== localDay(timeZone).day) {
			void refresh();
			// A monthly stop holds until the refresh says otherwise.
			if (!(status.reason ?? "").startsWith("This month")) return undefined;
		}
		return status.reason;
	}

	/** The models, with every lookup refused while the guard is stopped. */
	function guard(models: Models): Models {
		return new Proxy(models, {
			get(target, key) {
				if (key === "getModel") {
					return (provider: string, id: string) => (blocked() === undefined ? target.getModel(provider, id) : undefined);
				}
				// SAFETY: a get trap is only asked for keys of the object it wraps.
				const value = target[key as keyof Models];
				return value instanceof Function ? value.bind(target) : value;
			},
		});
	}

	/** Lets today go `amount` dollars past the daily limit. */
	async function allowMore(amount: number): Promise<BudgetStatus> {
		const root = await harness!.root(background);
		const { day } = localDay(timeZone);
		await root.commit(async (tx) => {
			const doc = await tx.doc(Budget);
			doc.extra[day] = (doc.extra[day] ?? 0) + amount;
			// Tell the owner again if it's reached a second time.
			if (doc.stopped === day) delete doc.stopped;
		}, background);
		return refresh();
	}

	return {
		attach(h: Harness) {
			harness = h;
			h.subscribeClose(() => void (closed = true));
			return refresh();
		},
		refresh,
		blocked,
		guard,
		allowMore,
		limits,
		status: () => status,
		extension: defineExtension({
			name: "budget",
			hooks: [hook(GenerationTask, { afterResponse: () => void refresh().catch((error) => console.error("[budget]", error)) })],
		}),
	};
}

export type BudgetGuard = ReturnType<typeof createBudget>;
