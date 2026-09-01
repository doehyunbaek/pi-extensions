# Pi Extensions

Monorepo for the following [Pi](https://github.com/earendil-works/pi) extensions:

- [`pi-multicodex`](./multicodex) — rotate multiple ChatGPT Codex OAuth accounts
- [`pi-provider-litellm`](./litellm) — use models and tools exposed by a LiteLLM proxy
- [`pi-system-prompt`](./system-prompt) — inspect Pi's resolved system prompt
- [`pi-autogist`](./autogist) — automatically back up session JSONL files to secret GitHub gists

## Install

Install the whole package from GitHub:

```sh
pi install git:github.com/doehyunbaek/pi-extensions
```

Use `pi config` to enable or disable individual extensions.

## Development

Install workspace dependencies:

```sh
npm install
```

Run all checks:

```sh
npm run check
```
