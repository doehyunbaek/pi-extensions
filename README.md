# Pi Extensions

Monorepo for the following [Pi](https://github.com/earendil-works/pi) extensions:

- [`pi-provider-litellm`](./litellm) — use models and tools exposed by a LiteLLM proxy
- [`pi-system-prompt`](./system-prompt) — inspect Pi's resolved system prompt
- [`pi-autogist`](./autogist) — automatically back up session JSONL files to secret GitHub gists
- [`pi-provider-codex-lb`](./codex-lb) — discover models and capabilities from a Codex LB gateway (requires Pi 1.6.0 or newer)

## Install

Install the whole package from GitHub:

```sh
pi install git:github.com/doehyunbaek/pi-extensions
```

Use `pi config` to enable or disable individual extensions. Codex LB requires endpoint and authentication configuration in your trusted global `models.json`; see [its setup instructions](./codex-lb/README.md#enable).

## Development

Install workspace dependencies:

```sh
npm install
```

Run all checks:

```sh
npm run check
```
