# Plan

## Decisions

- dreamwalker is a new project, not a fork of gaidin. gaidin assumes one always-on process, a SQLite file on its own disk, bubblewrap, a Unix socket and Tailscale; a Netlify Server sleeps after five minutes idle, loses its disk on every restart, and has none of the others. Seams for both in one codebase would cost more than they save, and gaidin on its VM stays the agent in daily use.
- The core is the same: Pi Durable, pi-ai and chord, pinned at 1.3.0 and upgraded deliberately. gaidin's modules that don't depend on the VM are copied in one at a time, when a feature needs them, and adapted. There are no merges from upstream. `src/parse.ts` is the first.
- It runs as one Netlify Server (`netlify/server/index.ts`), on the `/api/*` paths for now. Static files and the app come later.
- Memory and the local disk are never storage. Everything that has to survive goes in Netlify Database or Netlify Blobs.
- Pi Durable's own SQLite storage runs on Netlify Database through a Postgres version of its database facade (`src/storage/postgres.ts`), not a port of the storage: its SQL is portable enough to translate placeholders and `INSERT OR IGNORE`, so its storage code and its fixes stay Pi Durable's. Its tables are prefixed `pi_`. It passes Pi Durable's storage conformance suite.
- The schema comes only from `netlify/database/migrations`, applied by the deploy, as Netlify Database expects. The facade refuses DDL, so a Pi Durable upgrade that changes the schema fails at start until its next version is added as a migration.
- One writer at a time through a lease row (`src/storage/lease.ts`): a newer deploy takes it over at once, an older one only once it has run out (60 seconds), and every transaction renews it under the row's lock and fails if it was taken, so an instance that lost it can't commit. That instance's API answers 503; any other storage failure reopens the storage from the last commit.
- Web search is Anthropic's, through the Gateway, rather than a search API with a key of its own (gaidin uses Tavily): one account, and its cost is in the budget like the model's.
- Claude through Netlify's AI Gateway, no key of our own. Its credentials are in the environment only while a request is being handled, and reminders, jobs and resumed runs call the model outside one, so `src/model.ts` keeps the newest it has seen and every request refreshes them; `/api/wake` brings one every few minutes. An `ANTHROPIC_API_KEY` set on the site wins, since the Gateway never overrides it.
- A spend guard, from gaidin, because the AI Gateway and Netlify Database bill the site's team: model requests stop at `DREAMWALKER_BUDGET_DAILY` ($5 by default) or `DREAMWALKER_BUDGET_MONTHLY` ($50 by default), counted from Pi Durable's costs in `DREAMWALKER_TZ`'s days (UTC by default). Database compute isn't counted. Until there's a way to reach the owner, its warnings go to the server's log and `/api/status`.
- Production is public and previews keep the team's login: Netlify's login and password both use the `Authorization` header our token does, and pings and webhooks can't sign in.
- The storage opens on the first request, not at startup: in a deployed Server, `NETLIFY_DB_URL` isn't in the environment while the module loads.
- Every route but `/api/health` and `/api/wake` needs the owner's token (`DREAMWALKER_TOKEN`, a secret on the site); without one they're refused except under `netlify dev`.
- Production deploys come from git: a push to `main` builds on Netlify. `netlify deploy` from the CLI (27.13.0) uploads the migrations but doesn't apply them on a site with a Server; a git build does.
- Same conventions as gaidin: pnpm, `pnpm check` (tsc, oxlint with the anti-slop rules, tests on the faux model), packages at least 3 days old.

## The platform, as dreamwalker relies on it

- One instance per deploy, 1 GB of memory and 1 vCPU, Node.js 24.
- It starts on the first request, sleeps after five minutes without one, and is replaced after eight hours regardless. `onShutdown` hooks share about 25 seconds.
- A request can run 30 minutes (2 hours on Pro); response headers must start within 60 seconds. Work that outlives its request is registered with `getContext().waitUntil()`.
- Netlify Sandboxes: named VMs with their own persistent disk, an egress allowlist, and secrets swapped in only on requests to named hosts.

## How gaidin's assumptions map

| gaidin | dreamwalker |
|---|---|
| `gaidin.sqlite` on the VM's disk | Pi Durable storage on Netlify Database, one writer at a time through a lease |
| `history.sqlite`, an FTS5 index of the transcript | Rebuilt from the transcript, or Postgres full-text search |
| One process, always on | Asleep after five minutes. Pi Durable resumes where it stopped; something outside requests `/api/wake` every few minutes so reminders and jobs fire on time |
| bubblewrap, a sandbox directory per agent | A Netlify Sandbox per agent, behind Pi Durable's `ExecutionEnv` |
| CLI over a Unix socket | The HTTP API, with the owner's token |
| The app behind Tailscale | Netlify Identity or the owner's token; routes that ntfy and voice call check their own secret |
| Slack over Socket Mode | Works while awake; the Events API later, which wakes the server itself |
| Skills repo, connector vault, browser profiles on disk | Blobs or Database |
| Workspaces and the homelab over SSH and Tailscale | Not for now |
| Chromium and poppler on the VM | Not for now; later inside a Sandbox |

## Done

1. The skeleton: Pi Durable on memory storage inside a Netlify Server, the faux model or Claude, and `POST /api/ask`, running under `netlify dev`.
2. Netlify Database storage: Pi Durable's SQLite storage on a Postgres facade, its schema as a migration, the lease, and reopening after a storage failure. Tests run Pi Durable's 24 storage conformance cases on an in-process Postgres (`@netlify/database-dev`); under `netlify dev` a conversation survives a restart.
3. Claude through the AI Gateway with credentials kept between requests, the owner's token on every route but health and wake, `/api/wake`, and `/api/status` (the deploy, the storage, and where the model's credentials came from and how old they are, never the key).
4. The spend guard: daily and monthly limits, 80% and stop warnings, `GET /api/budget` and `POST /api/budget/allow`, and the storage opening on the first request.
5. Deployed: the site runs as a Netlify Server, production is public with previews behind the team's login, and it answers with Claude (Haiku 5.5) through the AI Gateway, from Netlify Database, under the spend guard. A conversation started on another model takes the site's model when the host opens.
6. Staying awake: a scheduled function requests `/api/wake` every four minutes.
7. The `dreamwalker` command: `ask`, `status`, `budget`, `allow` and `wake` over the API, with the URL and token from `.env`.
8. Reminders, from gaidin, for one agent and the owner's phone: `remind`, `list_reminders` and `cancel_reminder`, a background task per reminder that survives restarts, five tries to push, and a record in the transcript. They reach the owner through ntfy (`NTFY_URL`, `NTFY_TOKEN`), or the server's log without it. Each message is stamped with the local time (`DREAMWALKER_TZ`) and the prompt names the owner (`DREAMWALKER_OWNER`). Not yet: gaidin's snooze buttons (the phone would carry the owner's token), speakers and agents, and the guard on cancelling, which comes with approvals.
9. Memory, from gaidin, for one agent: notes in every prompt, kept with `remember`, `update_memory` and `forget`, 500 characters a note and 8,000 in all, and the owner's `GET /api/memory` and `POST /api/memory/add`, `update` and `forget`, with `dreamwalker memory`, `remember` and `forget`. Not yet: asking before a write after outside text, which comes with approvals.
10. Approvals, from gaidin, for one agent: a beforeTool hook that refuses a call that can't succeed, asks the owner about one its guard asks about, and waits up to 7 days, with the request id memoized on the tool task so a restart finds the same request. `fetch_url` (public addresses only, checked at connect time) asks for a host not allowed for good and offers to allow it; `remember`, `update_memory`, `forget` and `cancel_reminder` ask once outside text is in the conversation. `ask_owner` asks a question; the owner's next message answers it, or closes a waiting approval as superseded. `GET /api/approvals`, `POST /api/approvals/decide`, `answer` and `forget-host`; `dreamwalker requests`, `approve`, `deny` and `answer`; each outcome in the transcript. Not yet: gaidin's rules, redaction, and Slack's buttons.
11. Web search through the AI Gateway: pi-ai can't hand the model Anthropic's server-side web search, so `web_search` makes its own request to Claude with that tool on (`@anthropic-ai/sdk`, at the version pi-ai pins), on the site's model and credentials, and returns the results and Claude's cited notes, labelled as the web's. Its cost (tokens and a cent a search) goes into Pi Durable's usage, so the spend guard counts it. Searching doesn't ask; its results are outside text; a URL it returned fetches without asking. None on the faux model.

## Open questions

- `DEPLOY_ID` isn't set inside a deployed Netlify Server, so every instance counts as the newest. That's still safe, since the fence stops whichever lost the lease, but an old deploy's URL could take the lease back from production. The request's context has the deploy ID; the lease could take it from the first request.
- How long the Gateway's credentials stay good after the request that brought them. If it's shorter than the gap between wake-ups, background calls need a key set on the site. Scheduled jobs are the first model calls made outside a request; reminders only push.
- Sandboxes: the SDK is `plinthwick` on npm, despite its description. Pi's own remote environment, `pi-env`, needs its daemon started as a local child process, which a Netlify Server shouldn't spawn, so dreamwalker's `ExecutionEnv` will be its own over the SDK's commands and files. What the sandbox image has (a shell, coreutils, python) decides how its file operations are built.
- Commits are a dozen or so round trips on one connection. Fine in the same region as the database; worth measuring once deployed.

## Next

1. Sandboxes, once the site can use them: an `ExecutionEnv` over a Netlify Sandbox, checked with `registerEnvConformance`, and `CodingTools`.
2. From gaidin, in order: scheduled jobs, Slack, agents, then redaction and rules.
