# dreamwalker

A personal agent for one person, built on [Pi Durable](https://earendil.com/posts/pi-durable/) and run as a Netlify Server. The server sleeps when nobody needs it and wakes on the next request; a run, a reminder or a question waiting for an answer carries on from where it stopped.

In the Wheel of Time, a Dreamwalker walks Tel'aran'rhiod while asleep. Its older sibling, [gaidin](https://github.com/brad-j/gaidin), keeps watch from a VM that never sleeps.

## Try it locally

With Node.js 24, pnpm, and netlify-cli 27.10.0 or later:

```sh
pnpm install
DREAMWALKER_MODEL=faux pnpm dev       # the scripted model: no key, no network
netlify database migrations apply     # once, in a second terminal, while dev runs
curl -X POST localhost:8888/api/ask -H 'content-type: application/json' -d '{"message":"hello"}'
pnpm check                            # type check, lint and tests
```

Conversations are kept in Netlify Database, which `netlify dev` runs locally; a deploy applies the migrations itself. `DREAMWALKER_STORAGE=memory` keeps them in memory instead, gone on restart.

## The command

With `DREAMWALKER_URL` and `DREAMWALKER_TOKEN` in `.env` (or `DREAMWALKER_URL=http://localhost:8888` under `netlify dev`):

```sh
pnpm dreamwalker ask "remind me what we talked about"
pnpm dreamwalker status       # the instance, storage, budget and model credentials
pnpm dreamwalker budget       # today's and this month's spend against the limits
pnpm dreamwalker allow 5      # let today go $5 past the daily limit
```

On Netlify, Claude comes through the AI Gateway with no key of your own. Locally, set `ANTHROPIC_API_KEY` instead of `DREAMWALKER_MODEL=faux`. `DREAMWALKER_MODEL_ID` picks the model, `claude-haiku-5-5` by default.

## Status

Early: one conversation with Claude over HTTP and the `dreamwalker` command, kept in Netlify Database, under a spend limit, and deployed by pushing to `main`. [docs/plan.md](docs/plan.md) has the decisions and what's next.

## License

MIT, in [LICENSE](LICENSE).
