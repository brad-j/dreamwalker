# dreamwalker

A personal agent for one person on Pi Durable, built for Netlify Server: the platform runs it on demand and it sleeps when idle. Its older sibling is gaidin (`../gaidin` if checked out, or github.com/brad-j/gaidin), which runs on a VM; dreamwalker copies gaidin's modules that don't depend on the VM, one at a time, and doesn't merge from it.

## Commands

- `pnpm install`, then `pnpm check` before every commit: `tsc`, oxlint with the anti-slop rules, and every test.
- One test file while working: `node --no-warnings --test test/api.test.ts`.
- `pnpm dreamwalker ask "..."` (`--agent ID` for another agent; also `agents`, `agent-add`, `archive-agent`, `restore-agent`, `status`, `budget`, `allow`, `wake`, `memory`, `remember`, `forget`, `requests`, `approve`, `deny`, `answer`, `jobs`, `pause-job`, `resume-job`, `cancel-job`) talks to the server named by `DREAMWALKER_URL` with `DREAMWALKER_TOKEN`, both from `.env`.
- `DREAMWALKER_MODEL=faux pnpm dev` runs the server under `netlify dev` on a scripted model, with no key or network. It needs Node.js 24 and netlify-cli 27.10.0 or later.
- Deploy by pushing to `main`; Netlify builds it. Not `netlify deploy`: from the CLI, new migrations are uploaded but not applied.
- `netlify database migrations apply` (while `pnpm dev` runs) applies new migrations to the local database. Deploys apply them themselves.
- Tests run on Pi Durable's faux provider and an in-process Postgres (`@netlify/database-dev`) with the migrations applied. Don't add a test that needs a key or the network.
- `test/helpers.ts` has what the tests share: the faux model scripted step by step (`fauxModels`, `call`, `say`), the system prompt it was sent (`system`), and `until`. Pi Durable's conformance suites use `nodeAssertions` from `src/sandbox-check.ts`.

## Where things are

- [docs/plan.md](docs/plan.md) holds the decisions, how gaidin's assumptions map onto the platform, the numbered Done list and Next. Read it before starting. A finished feature gets the next Done item, and a changed decision is changed there.
- `netlify/server/index.ts` is the Server's entry: it opens the host once per instance and exports the API's fetch handler. Everything else is in `src/`.
- `src/storage/` is Pi Durable's storage on Netlify Database: the Postgres facade, the lease, and opening both. The schema is `netlify/database/migrations/`.
- `src/agents.ts` and `src/roster.ts` are the named agents: the roster, which agent each conversation belongs to (`AgentOf`, copied to the conversations one makes), and the identity prompt.
- `src/worker.ts` is the split: the main agent holds the owner's data and has no way out; workers have the internet and none of the data.
- `src/sandbox-env.ts` is the worker's computer, an `ExecutionEnv` over a Netlify Sandbox; `sandbox/helper.mjs` runs inside it on Pi Durable's own environment. After changing the helper or upgrading Pi Durable, run `node --no-warnings scripts/sandbox-files.ts` to regenerate `src/sandbox-files.ts`.

## Rules

- Nothing may live only in memory or on the instance's disk: an instance sleeps after five minutes without a request, is replaced after eight hours, and starts empty. Durable state goes through Pi Durable's storage or Netlify Blobs.
- `getContext()` and anything built from it exist only while a request is being handled. Code that runs for reminders, jobs or resumed tasks can't use them.
- Schema changes are new migration files in `netlify/database/migrations/`, never edits to an applied one and never DDL at runtime. That includes Pi Durable's tables when an upgrade raises its schema version.
- The safety code is `src/approvals.ts`, `guards.ts`, `outside.ts`, `fetch.ts`, `worker.ts` with which extensions the main agent and workers get in `host.ts`, `workspace.ts`, the sandboxes' network policies in `sandbox.ts`, the guards beside each tool, `src/storage/lease.ts` and the token check in `src/api.ts`. A change that lets through anything these used to stop or ask about says so in its commit message and has a test. Never weaken or delete a test of them to make a change pass.
- Satisfy the anti-slop lint rules (`tools/oxlint/anti-slop/`) by changing the code. Don't turn a rule off, add an override or add an ignore comment.
- Pi Durable, pi-ai and chord are pinned and upgraded deliberately. Don't add or upgrade a package as part of a task; say that one is needed. pnpm resolves only versions at least 3 days old (`minimumReleaseAge: 4320`).
- Nothing about the owner's own setup goes in code, tests or docs: no real names, site IDs, host names or home paths. Use `example.com` and `*.test` names, and call the person "the owner" in docs.
- Commit messages describe the change in a sentence or more of prose, with no `feat:`-style prefixes.

## Mistakes agents have made

Add a line here each time an agent gets something wrong that a line here would have prevented.

- An agent took every user message for the owner's. Job prompts carrying earlier reports, and compaction summaries of history with outside text, came in as user messages too, so guards trusted them. The owner's messages are marked where they come in (`OwnerMessage`); anything else that reads as a user message is outside text unless `outside.ts` shows otherwise, so a new path into a conversation starts distrusted.

- An agent opened the sandbox to the internet and stopped fetch_url asking, citing what Claude Code and Codex were said to do, and both do keep a gate. Before loosening a safety gate, check the claim, and say what the agent could then send where: it holds the owner's notes and conversation.
- A sandbox keeps the network policy it was made with, and the SDK doesn't compare policies when it finds a sandbox by name. Changing a sandbox's policy under the same name changes nothing; it needs a new name, and the probe shows what the network reaches.
