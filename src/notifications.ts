// Notifications, from gaidin: everything dreamwalker tells the owner without being asked, and which way each goes.
// Reminders, job reports and budget warnings are handed here as notices; each way of reaching the owner writes a
// notice its own way. For now that's ntfy alone; the app shows reports in the conversation either way.
//
//   reminder         ntfy, which must reach the owner
//   report, paused   the same
//   budget           the same
import type { Report } from "./jobs.ts";
import type { Reminder } from "./reminders.ts";

export type Notice =
	| { kind: "reminder"; reminder: Reminder }
	| { kind: "report"; report: Report }
	/** A job that paused after failing in a row, which the owner can resume. */
	| { kind: "paused"; report: Report }
	| { kind: "budget"; text: string };

/** One way to reach the owner. `send` resolves with whether it reached anyone, and throws when it failed. */
export type Adapter = { send(notice: Notice): Promise<boolean> };
export type Adapters = { ntfy?: Adapter };

/** One line for the server's output, when nothing else reached the owner. */
function describe(notice: Notice): string {
	switch (notice.kind) {
		case "reminder":
			return `reminder: ${notice.reminder.text}`;
		case "report":
		case "paused":
			return `${notice.report.title}: ${notice.report.text}`;
		case "budget":
			return `budget: ${notice.text}`;
	}
}

export function createNotifications(adapters: Adapters) {
	const required = [adapters.ntfy].filter((a) => a !== undefined);

	return {
		/**
		 * Tells the owner. Throws when none of the ways that must reach them did and one failed, so a reminder is tried
		 * again later. When nothing reached the owner without failing, as with no way set up, prints to the server's
		 * output.
		 */
		async send(notice: Notice): Promise<void> {
			const errors: unknown[] = [];
			let told = false;
			for (const adapter of required) {
				try {
					if (await adapter.send(notice)) told = true;
				} catch (error) {
					errors.push(error);
				}
			}
			if (!told && errors.length > 0) throw errors[0];
			for (const error of errors) console.error("[notify]", error);
			if (!told) console.error(`[notify] ${describe(notice)} (nothing reached the owner: NTFY_URL isn't set)`);
		},
	};
}

export type Notifications = ReturnType<typeof createNotifications>;
