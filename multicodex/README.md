# MultiCodex

Forked from [kim0/pi-multicodex](https://github.com/kim0/pi-multicodex).

## Commands

- `/multicodex-login` — add a ChatGPT Codex account.
- `/multicodex-usage` — force-refresh every account's limits and reset times; select an account, then choose to use it or redeem an available usage-limit reset.
- `/multicodex-analyze` — show the local per-account request heatmap.

`/multicodex-usage` uses the same ChatGPT backend endpoints as the OpenAI Codex CLI: `GET /wham/usage`, `GET /wham/rate-limit-reset-credits`, and, after confirmation, `POST /wham/rate-limit-reset-credits/consume` with an idempotency key.
