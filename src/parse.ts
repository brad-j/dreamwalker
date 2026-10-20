// Parsing outside input: request bodies, button values, JSON from other programs and services, and the
// settings file. This is the one module that looks at values of unknown shape (.oxlintrc.json lets it);
// everything else gets typed values, or a ParseError that says what was wrong and where.
//
//   const body = parse(await response.json(), object({ ok: boolean, ts: optional(string) }), "Slack's answer");
//
// Objects ignore fields they don't name, since services add fields. A field whose parser allows undefined
// is optional, and left out of the result when it's absent or null.

/** Any value JSON can hold. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type Input = Json | undefined;

/** Turns a value into a T, or throws a ParseError naming `at`, the value's place in the input. */
export type Parser<T> = (value: Input, at: string) => T;

export class ParseError extends Error {}

const fail = (at: string, expected: string) => new ParseError(`${at} should be ${expected}`);

export const isObject = (value: Input): value is { readonly [key: string]: Json } => typeof value === "object" && value !== null && !Array.isArray(value);

export const string: Parser<string> = (value, at) => {
	if (typeof value !== "string") throw fail(at, "a string");
	return value;
};

/** A finite number. */
export const number: Parser<number> = (value, at) => {
	if (typeof value !== "number" || !Number.isFinite(value)) throw fail(at, "a number");
	return value;
};

export const integer: Parser<number> = (value, at) => {
	const n = number(value, at);
	if (!Number.isInteger(n)) throw fail(at, "a whole number");
	return n;
};

export const boolean: Parser<boolean> = (value, at) => {
	if (typeof value !== "boolean") throw fail(at, "true or false");
	return value;
};

/** Any JSON value, as it is. */
export const json: Parser<Json> = (value, at) => {
	if (value === undefined) throw fail(at, "present");
	return value;
};

/** A string as it is, and any other JSON value as JSON text. */
export const text: Parser<string> = (value, at) => (typeof value === "string" ? value : JSON.stringify(json(value, at)));

/** `value` as `parser` reads it, or nothing when it doesn't, for a field that's only used when it's right. */
export function attempt<T>(value: Input, parser: Parser<T>): T | undefined {
	try {
		return parser(value, "");
	} catch (error) {
		if (error instanceof ParseError) return undefined;
		throw error;
	}
}

/** A string, integer or boolean as a header or a label carries it: as text. */
export const scalar: Parser<string> = (value, at) => {
	if (typeof value === "string") return value;
	if ((typeof value === "number" && Number.isSafeInteger(value)) || typeof value === "boolean") return String(value);
	throw fail(at, "a string, integer or boolean");
};

/** Any JSON object, as it is. */
export const jsonObject: Parser<{ readonly [key: string]: Json }> = (value, at) => {
	if (!isObject(value)) throw fail(at, "an object");
	return value;
};

/** One of the given strings. */
export function literal<const T extends string>(...values: readonly T[]): Parser<T> {
	return (value, at) => {
		const found = values.find((v) => v === value);
		if (found === undefined) throw fail(at, values.map((v) => JSON.stringify(v)).join(" or "));
		return found;
	};
}

/** Absent or null as undefined, and anything else as `parser` has it. */
export function optional<T>(parser: Parser<T>): Parser<T | undefined> {
	return (value, at) => (value === undefined || value === null ? undefined : parser(value, at));
}

/** Absent or null as null, and anything else as `parser` has it. */
export function nullable<T>(parser: Parser<T>): Parser<T | null> {
	return (value, at) => (value === undefined || value === null ? null : parser(value, at));
}

export function array<T>(item: Parser<T>): Parser<T[]> {
	return (value, at) => {
		if (!Array.isArray(value)) throw fail(at, "a list");
		return value.map((v, i) => item(v, `${at}[${i}]`));
	};
}

/** An object used as a map from names to values. */
export function dictionary<T>(item: Parser<T>): Parser<Map<string, T>> {
	return (value, at) => {
		if (!isObject(value)) throw fail(at, "an object");
		return new Map(Object.entries(value).map(([key, v]) => [key, item(v, `${at}.${key}`)]));
	};
}

/** A parser for each field an object must or may have. */
type Fields = { readonly [key: string]: Parser<unknown> };
type Required<F extends Fields> = { [K in keyof F as undefined extends ReturnType<F[K]> ? never : K]: ReturnType<F[K]> };
type Optional<F extends Fields> = { [K in keyof F as undefined extends ReturnType<F[K]> ? K : never]?: Exclude<ReturnType<F[K]>, undefined> };
/** The object `fields` describes. */
export type ObjectOf<F extends Fields> = { [K in keyof (Required<F> & Optional<F>)]: (Required<F> & Optional<F>)[K] };

export function object<F extends Fields>(fields: F): Parser<ObjectOf<F>> {
	return (value, at) => {
		if (!isObject(value)) throw fail(at, "an object");
		const parsed = Object.entries(fields).flatMap(([key, parser]) => {
			const field = parser(value[key], `${at}.${key}`);
			return field === undefined ? [] : [[key, field] as const];
		});
		// SAFETY: every field went through its parser, and only the ones that came out undefined are left out.
		return Object.fromEntries(parsed) as ObjectOf<F>;
	};
}

/** `value` as `parser` has it; `what` names the input in the error. */
export function parse<T>(value: Input, parser: Parser<T>, what: string): T {
	return parser(value, what);
}

/** `text` read as JSON, then as `parser` has it. */
export function parseJson<T>(text: string, parser: Parser<T>, what: string): T {
	let value: Json;
	try {
		// JSON.parse gives only JSON values.
		value = JSON.parse(text);
	} catch {
		throw new ParseError(`${what} isn't JSON`);
	}
	return parser(value, what);
}
