// Times as the owner reads them, in the configured time zone (DREAMWALKER_TZ). One server per process, so the
// zone is set once, by openHost.
let zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let formatter = makeFormatter(zone);

function makeFormatter(timeZone: string) {
	return new Intl.DateTimeFormat("en-US", {
		timeZone,
		weekday: "short",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZoneName: "shortOffset",
	});
}

export function setTimeZone(timeZone: string) {
	zone = timeZone;
	formatter = makeFormatter(timeZone);
}

export function timeZone(): string {
	return zone;
}

/** A message as the model sees it. The time goes here, not in the system prompt, so the prompt cache stays valid. */
export function stamp(content: string, ms = Date.now()): string {
	return `[${formatTime(ms)}] ${content}`;
}

/** "19:30:05", the time of day to the second, in the configured time zone. */
export function formatClock(ms: number): string {
	return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(ms);
}

/** "Thu 2026-10-08 19:30 GMT-4" in the configured time zone. */
export function formatTime(ms: number): string {
	const p = Object.fromEntries(formatter.formatToParts(ms).map((part) => [part.type, part.value]));
	return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}
