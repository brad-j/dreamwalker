// Notifications through ntfy, from gaidin: posts to a topic URL, e.g. https://ntfy.sh/<topic>. The topic name is a
// secret. notifications.ts decides which notices come this way. gaidin's snooze buttons aren't here: the phone would
// call dreamwalker with the owner's token, which would then sit in every message on ntfy's server.
import type { Adapter } from "./notifications.ts";

export type NtfySettings = { url: string; token?: string };

/** The ntfy settings from the environment, `NTFY_URL` and `NTFY_TOKEN`, or nothing without a URL. */
export function ntfySettingsFrom(env: NodeJS.ProcessEnv): NtfySettings | undefined {
	const url = env.NTFY_URL;
	if (url === undefined || url === "") return undefined;
	new URL(url);
	return env.NTFY_TOKEN ? { url, token: env.NTFY_TOKEN } : { url };
}

async function post(ntfy: NtfySettings, body: string, headers: Headers, request: typeof fetch) {
	if (ntfy.token) headers.set("Authorization", `Bearer ${ntfy.token}`);
	const response = await request(ntfy.url, { method: "POST", body, headers, signal: AbortSignal.timeout(15_000) });
	if (!response.ok) throw new Error(`ntfy answered ${response.status}`);
}

/** ntfy as a way to reach the owner: reminders as alarms, job reports and budget warnings as text. */
export function ntfyAdapter(ntfy: NtfySettings, request: typeof fetch = fetch): Adapter {
	return {
		async send(notice) {
			switch (notice.kind) {
				case "reminder":
					await post(ntfy, notice.reminder.text, new Headers({ Title: "dreamwalker", Tags: "alarm_clock" }), request);
					return true;
				case "budget":
					await post(ntfy, notice.text, new Headers({ Title: "dreamwalker: budget", Tags: "moneybag" }), request);
					return true;
				case "report":
				case "paused": {
					const text = notice.report.text.length > 3000 ? `${notice.report.text.slice(0, 3000)}…` : notice.report.text;
					// Header values must be ASCII.
					await post(ntfy, text, new Headers({ Title: `dreamwalker: ${notice.report.title}`.replace(/[^\x20-\x7e]/g, "?"), Tags: "calendar", Markdown: "yes" }), request);
					return true;
				}
			}
		},
	};
}
