// Redaction, from gaidin: the server's own secrets kept out of every tool result before it's stored, as a last check.
// dreamwalker's design is what keeps them away from tools in the first place: no tool reads the server's environment,
// a worker's sandbox has none of it, and the Netlify tools send their token without ever returning it. This catches
// what that misses, such as an error that echoes a request, by matching each secret's value as it is (an encoded copy
// would get through) and putting `[redacted NAME]` in its place. Values under 8 characters aren't matched.
//
// It works on a tool's final result, through an afterTool hook; output a running tool commits on the way isn't redacted
// until the result is in.
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";

/** A secret by the name it's redacted as, and its value as it stands now. */
export type Secret = { name: string; value: string };

const MIN_LENGTH = 8;

/** `text` with every secret's value replaced by its name, the longest first so one inside another is caught whole. */
export function redact(text: string, secrets: readonly Secret[]): string {
	let out = text;
	for (const { name, value } of [...secrets].filter((s) => s.value.length >= MIN_LENGTH).sort((a, b) => b.value.length - a.value.length)) {
		out = out.split(value).join(`[redacted ${name}]`);
	}
	return out;
}

/**
 * Every string in a JSON value redacted, whatever its depth: the value is redacted as JSON text, with each secret as it
 * is and as JSON writes it inside a string, so one with a quote or a backslash is caught too.
 */
function redactDeep<T>(value: T, secrets: readonly Secret[]): T {
	const escaped = secrets.map((s) => ({ name: s.name, value: JSON.stringify(s.value).slice(1, -1) }));
	// SAFETY: a tool result is JSON, and a secret's value is replaced only where it appears within a string, by text with
	// no character JSON escapes, so the text still parses as the same shape.
	return JSON.parse(redact(JSON.stringify(value), [...secrets, ...escaped])) as T;
}

/** The hook that redacts each tool's result; `secrets` is read at each call, as some values change. */
export function redaction(secrets: () => readonly Secret[]) {
	return defineExtension({
		name: "redaction",
		hooks: [
			hook(ToolTask, {
				afterTool: (_call, result) => {
					const current = secrets();
					return current.length === 0 ? result : redactDeep(result, current);
				},
			}),
		],
	});
}
