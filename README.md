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

For Claude, set `ANTHROPIC_API_KEY` instead of `DREAMWALKER_MODEL=faux`. `DREAMWALKER_MODEL_ID` picks the model, `claude-haiku-5-5` by default.

## Status

Early: one conversation over HTTP, kept in Netlify Database, and not yet deployed. [docs/plan.md](docs/plan.md) has the decisions and what's next.

## License

MIT, in [LICENSE](LICENSE).
