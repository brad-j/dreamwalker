// The Netlify tools: read-only access to one Netlify team, for the agents granted "netlify" (agents.ts). They call
// Netlify's API from the server with a personal access token (`NETLIFY_AGENT_PAT`, a secret on the site), which never
// reaches the model: it sees only the fields each tool names.
//
// A personal access token acts as its user on every team the user is in, so where it reaches is checked, not assumed:
// before any call, the token's teams are listed, and unless they're exactly the one configured (`NETLIFY_AGENT_TEAM`),
// every tool refuses and says which it found. Each answer is checked to be the team's too. Every tool picks the fields
// it returns rather than passing Netlify's answer on, since sites, deploys and variables carry secrets (a site's
// password and deploy hook, variables' values, skew protection tokens). What comes back is outside text: anyone who can
// push to a site's repository writes its deploy titles and commit messages.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { guard } from "./guards.ts";
import { isObject, type Json, object } from "./parse.ts";

export type NetlifySettings = { token: string; team: string };

/** The settings from the environment, or undefined when either is missing. */
export function netlifySettingsFrom(env: NodeJS.ProcessEnv): NetlifySettings | undefined {
	const token = env.NETLIFY_AGENT_PAT?.trim();
	const team = env.NETLIFY_AGENT_TEAM?.trim();
	return token && team ? { token, team } : undefined;
}

export type NetlifyOptions = {
	/** Netlify's API, replaced by a fake one in tests. */
	fetch?: typeof globalThis.fetch;
	base?: string;
	/** How long a check of the token's teams holds. */
	checkMs?: number;
};

const BASE = "https://api.netlify.com/api/v1";
const CHECK_MS = 10 * 60_000;
const MAX_OUTPUT = 20_000;

/** A field of a Netlify answer, when it's there. */
const at = (value: Json | undefined, ...path: string[]): Json | undefined => {
	let here = value;
	for (const key of path) {
		const next = here ?? null;
		here = isObject(next) ? next[key] : undefined;
	}
	return here;
};

/** The named fields of `value`, each read by its path, leaving out those that aren't there. */
function pick(value: Json | undefined, fields: { readonly [name: string]: readonly string[] }) {
	return Object.fromEntries(
		Object.entries(fields).flatMap(([name, path]) => {
			const found = at(value, ...path);
			return found === undefined || found === null || found === "" ? [] : [[name, found] as const];
		}),
	);
}

const SITE_SUMMARY = { name: ["name"], id: ["id"], url: ["ssl_url"], custom_domain: ["custom_domain"], repo: ["build_settings", "repo_url"], branch: ["build_settings", "repo_branch"], published: ["published_deploy", "published_at"], updated_at: ["updated_at"] };
const SITE = {
	...SITE_SUMMARY,
	domain_aliases: ["domain_aliases"],
	build_command: ["build_settings", "cmd"],
	publish_dir: ["build_settings", "dir"],
	functions_dir: ["build_settings", "functions_dir"],
	build_image: ["build_image"],
	functions_region: ["functions_region"],
	managed_dns: ["managed_dns"],
	force_ssl: ["force_ssl"],
	published_deploy_id: ["published_deploy", "id"],
	published_deploy_state: ["published_deploy", "state"],
	published_deploy_branch: ["published_deploy", "branch"],
	published_deploy_commit: ["published_deploy", "commit_ref"],
	created_at: ["created_at"],
};
const DEPLOY = {
	id: ["id"],
	site_id: ["site_id"],
	state: ["state"],
	context: ["context"],
	branch: ["branch"],
	commit: ["commit_ref"],
	title: ["title"],
	error: ["error_message"],
	locked: ["locked"],
	url: ["deploy_ssl_url"],
	framework: ["framework"],
	created_at: ["created_at"],
	published_at: ["published_at"],
};
const ZONE = { name: ["name"], id: ["id"], site_id: ["site_id"], dns_servers: ["dns_servers"] };
const RECORD = { hostname: ["hostname"], type: ["type"], value: ["value"], ttl: ["ttl"], priority: ["priority"], managed: ["managed"] };

/** A Netlify call that failed, said without the token. */
export class NetlifyError extends Error {}

export function createNetlify(settings: NetlifySettings | undefined, options: NetlifyOptions = {}) {
	const fetcher = options.fetch ?? globalThis.fetch;
	const base = options.base ?? BASE;
	let checked: { slug: string; until: number } | undefined;

	async function get(path: string): Promise<Json> {
		if (settings === undefined) throw new NetlifyError("Netlify isn't set up: NETLIFY_AGENT_PAT and NETLIFY_AGENT_TEAM aren't both set on the site.");
		const response = await fetcher(`${base}${path}`, { headers: { authorization: `Bearer ${settings.token}`, accept: "application/json" } });
		if (!response.ok) throw new NetlifyError(`Netlify answered ${response.status} for ${path.split("?")[0]}`);
		// SAFETY: Netlify's API answers JSON; what's read from it goes through `at` and `pick`, which check each field.
		return (await response.json()) as Json;
	}

	/** The configured team's slug, once the token is shown to reach that team and no other. */
	async function team(): Promise<string> {
		if (checked !== undefined && checked.until > Date.now()) return checked.slug;
		const accounts = await get("/accounts");
		const teams = Array.isArray(accounts) ? accounts : [];
		const ids = teams.map((t) => String(at(t, "id")));
		if (ids.length !== 1 || ids[0] !== settings!.team) {
			const names = teams.map((t) => `${String(at(t, "name"))} (${String(at(t, "id"))})`).join(", ") || "none";
			throw new NetlifyError(`Refusing: the token must reach only the configured team, and it reaches ${names}. Use a token from an account that's only in that team.`);
		}
		const slug = String(at(teams[0], "slug"));
		checked = { slug, until: Date.now() + (options.checkMs ?? CHECK_MS) };
		return slug;
	}

	/** Site `site` (an id or name), once it's shown to be the team's. */
	async function site(id: string): Promise<Json> {
		await team();
		const found = await get(`/sites/${encodeURIComponent(id)}`);
		if (at(found, "account_id") !== settings!.team) throw new NetlifyError(`${id} isn't one of the team's sites.`);
		return found;
	}

	const text = (value: Json) => {
		const json = JSON.stringify(value, null, 1);
		return json.length > MAX_OUTPUT ? `${json.slice(0, MAX_OUTPUT)}… (cut from ${json.length} characters)` : json;
	};
	const answer = (value: Json) => ({ output: [{ type: "text" as const, text: text(value) }] });
	const siteParam = Type.String({ description: "The site's id or name" });

	const tools = [
		defineTool({
			name: "netlify_sites",
			description: "List the team's Netlify sites: name, id, URL, custom domain, repository and branch, and when each was last published.",
			parameters: Type.Object({}),
			replay: "safe",
			execute: async () => {
				const slug = await team();
				const sites = await get(`/${encodeURIComponent(slug)}/sites?per_page=100`);
				return answer((Array.isArray(sites) ? sites : []).map((s) => pick(s, SITE_SUMMARY)));
			},
		}),
		defineTool({
			name: "netlify_site",
			description: "One site's settings: domains, build command and directories, build image, functions region, DNS and SSL, and its published deploy.",
			parameters: Type.Object({ site: siteParam }),
			replay: "safe",
			execute: async (args) => answer(pick(await site(args.site), SITE)),
		}),
		defineTool({
			name: "netlify_deploys",
			description: "A site's recent deploys, newest first: state, context, branch, commit, title, error and when.",
			parameters: Type.Object({ site: siteParam, limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, description: "Default 10" })) }),
			replay: "safe",
			execute: async (args) => {
				const found = await site(args.site);
				const deploys = await get(`/sites/${encodeURIComponent(String(at(found, "id")))}/deploys?per_page=${Math.round(args.limit ?? 10)}`);
				return answer((Array.isArray(deploys) ? deploys : []).map((d) => pick(d, DEPLOY)));
			},
		}),
		defineTool({
			name: "netlify_deploy",
			description: "One deploy, by id: state, context, branch, commit, title, error, framework and when.",
			parameters: Type.Object({ deploy: Type.String({ description: "The deploy's id" }) }),
			replay: "safe",
			execute: async (args) => {
				await team();
				const deploy = await get(`/deploys/${encodeURIComponent(args.deploy)}`);
				await site(String(at(deploy, "site_id")));
				return answer(pick(deploy, DEPLOY));
			},
		}),
		defineTool({
			name: "netlify_env_names",
			description: "The names of a site's environment variables, with their scopes, the contexts they're set for and whether they're secret. Never their values.",
			parameters: Type.Object({ site: siteParam }),
			replay: "safe",
			execute: async (args) => {
				const found = await site(args.site);
				const vars = await get(`/accounts/${encodeURIComponent(settings!.team)}/env?site_id=${encodeURIComponent(String(at(found, "id")))}`);
				return answer(
					(Array.isArray(vars) ? vars : []).map((v) => {
						const values = at(v, "values");
						return { ...pick(v, { key: ["key"], scopes: ["scopes"], secret: ["is_secret"], updated_at: ["updated_at"] }), contexts: (Array.isArray(values) ? values : []).map((x) => at(x, "context") ?? null) };
					}),
				);
			},
		}),
		defineTool({
			name: "netlify_dns",
			description: "The team's DNS zones, or with `zone` (an id from the list) that zone's records.",
			parameters: Type.Object({ zone: Type.Optional(Type.String()) }),
			replay: "safe",
			execute: async (args) => {
				const slug = await team();
				if (args.zone === undefined) {
					const zones = await get(`/dns_zones?account_slug=${encodeURIComponent(slug)}`);
					return answer((Array.isArray(zones) ? zones : []).map((z) => pick(z, ZONE)));
				}
				const zone = await get(`/dns_zones/${encodeURIComponent(args.zone)}`);
				if (at(zone, "account_id") !== settings!.team) throw new NetlifyError(`${args.zone} isn't one of the team's DNS zones.`);
				const records = await get(`/dns_zones/${encodeURIComponent(args.zone)}/dns_records`);
				return answer({ ...pick(zone, ZONE), records: (Array.isArray(records) ? records : []).map((r) => pick(r, RECORD)) });
			},
		}),
	];

	return {
		/** Whether the token and team are set; never either value. */
		configured: settings !== undefined,
		extension: defineExtension({ name: "netlify", tools }),
		// What Netlify answers is outside text.
		guards: tools.map((tool) => guard(tool.name, object({}), { outside: true })),
		/** The team's slug if the token reaches it and nothing else; throws with what it found otherwise. For the status route. */
		check: team,
	};
}

export type Netlify = ReturnType<typeof createNetlify>;
