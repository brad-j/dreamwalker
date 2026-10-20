# dreamwalker

A personal agent for one person on Pi Durable, built for Netlify Server: the platform runs it on demand and it sleeps when idle. Its older sibling is gaidin (`../gaidin` if checked out, or github.com/brad-j/gaidin), which runs on a VM; dreamwalker copies gaidin's modules that don't depend on the VM, one at a time, and doesn't merge from it.

## Commands

- `pnpm install`, then `pnpm check` before every commit: `tsc`, oxlint with the anti-slop rules, and every test.
- One test file while working: `node --no-warnings --test test/api.test.ts`.
- `DREAMWALKER_MODEL=faux pnpm dev` runs the server under `netlify dev` on a scripted model, with no key or network. It needs Node.js 24 and netlify-cli 27.10.0 or later.
- `netlify database migrations apply` (while `pnpm dev` runs) applies new migrations to the local database. Deploys apply them themselves.
- Tests run on Pi Durable's faux provider and an in-process Postgres (`@netlify/database-dev`) with the migrations applied. Don't add a test that needs a key or the network.

## Where things are

- [docs/plan.md](docs/plan.md) holds the decisions, how gaidin's assumptions map onto the platform, the numbered Done list and Next. Read it before starting. A finished feature gets the next Done item, and a changed decision is changed there.
- `netlify/server/index.ts` is the Server's entry: it opens the host once per instance and exports the API's fetch handler. Everything else is in `src/`.
- `src/storage/` is Pi Durable's storage on Netlify Database: the Postgres facade, the lease, and opening both. The schema is `netlify/database/migrations/`.

## Rules

- Nothing may live only in memory or on the instance's disk: an instance sleeps after five minutes without a request, is replaced after eight hours, and starts empty. Durable state goes through Pi Durable's storage or Netlify Blobs.
- `getContext()` and anything built from it exist only while a request is being handled. Code that runs for reminders, jobs or resumed tasks can't use them.
- Schema changes are new migration files in `netlify/database/migrations/`, never edits to an applied one and never DDL at runtime. That includes Pi Durable's tables when an upgrade raises its schema version.
- Satisfy the anti-slop lint rules (`tools/oxlint/anti-slop/`) by changing the code. Don't turn a rule off, add an override or add an ignore comment.
- Pi Durable, pi-ai and chord are pinned and upgraded deliberately. Don't add or upgrade a package as part of a task; say that one is needed. pnpm resolves only versions at least 3 days old (`minimumReleaseAge: 4320`).
- Nothing about the owner's own setup goes in code, tests or docs: no real names, site IDs, host names or home paths. Use `example.com` and `*.test` names, and call the person "the owner" in docs.
- Commit messages describe the change in a sentence or more of prose, with no `feat:`-style prefixes.

## Mistakes agents have made

Add a line here each time an agent gets something wrong that a line here would have prevented.
