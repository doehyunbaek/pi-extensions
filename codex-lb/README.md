# Codex LB provider for Pi

Discovers models and capabilities from the Codex LB gateway's `GET /v1/models` endpoint. Requires Pi 1.6.0 or newer. Uses Pi's built-in OpenAI Responses implementation; it does not reimplement streaming.

The directory/package is named `codex-lb`, but the provider ID remains **`doehyunbaek-llm`** so existing sessions and default-model settings remain valid.

## Enable

Keep the endpoint and authentication in your trusted global `~/.pi/agent/models.json` (or `$PI_CODING_AGENT_DIR/models.json`):

```json
{
  "providers": {
    "doehyunbaek-llm": {
      "baseUrl": "https://doehyunbaek.com/llm/v1",
      "api": "openai-responses",
      "apiKey": "!/bin/cat /home/doehyunbaek/.pi/agent/doehyunbaek-llm.key",
      "authHeader": true,
      "headers": {
        "cf-access-token": "!/home/doehyunbaek/.local/bin/cloudflared access token --app https://doehyunbaek.com/llm/"
      }
    }
  }
}
```

**Remove the provider's static `models` array** after backing up the file. Pi overlays `models.json` above extension models; old static definitions otherwise override discovered capabilities and retain retired models. Use `modelOverrides` only for deliberate per-model exceptions. Leave unrelated providers alone.

Add this path to the `extensions` array in `~/.pi/agent/settings.json`, preserving other settings:

```json
{
  "extensions": ["/home/doehyunbaek/public/pi-extensions/codex-lb/index.ts"]
}
```

Restart Pi, or `/reload` to load the changed extension settings. For a temporary test instead:

```bash
pi -e ~/public/pi-extensions/codex-lb --list-models doehyunbaek-llm
```

No default provider, model, or thinking setting is changed by this extension.

## Refresh and caching

- Fetches at extension startup, before model selection, including `--list-models` and print mode.
- Implements native provider discovery, so Pi's network-enabled refreshes (including opening `/model` in interactive mode) can discover releases during a session.
- `/codex-lb-refresh` explicitly forces a provider refresh.
- Pi stores runtime catalogs in its model store. A separate atomic `codex-lb-models.json` snapshot in the agent directory supports early/offline startup before the registry is initialized. This startup snapshot is updated on successful startup discovery.
- Failed requests, invalid catalogs, and empty catalogs do not replace a working catalog. First startup without either a reachable gateway or a valid snapshot reports an error.
- Discovery has a 30-second deadline; auth commands have a 15-second deadline and honor cancellation. No background polling or timers are installed.
- API keys and Cloudflare headers are resolved from existing configuration, not saved in either model cache. Never commit credentials. `!` commands in the trusted global config execute with your account permissions.

## Metadata policy

Maps display names, context windows, text/image inputs, reasoning support, and supported thinking levels. Unsupported Pi thinking levels are disabled explicitly. Gateway-only `ultra` is not mapped to a different Pi level.

The API remains `openai-responses`, matching the working provider configuration, rather than relying on the gateway's `api_types` hint.

When metadata is absent, the client defaults are 128,000 context tokens and 16,384 output tokens (capped to context). The gateway currently reports null output limits; the output default is **not a verified model limit**. Prices are zero/untracked because the gateway supplies no pricing.

## Tests

```bash
node --experimental-strip-types --test codex-lb/catalog.test.ts
```

The catalog tests are offline. Live model-list discovery has also been checked against the configured gateway. Streaming, image requests, and tool execution are delegated to Pi but have not been exercised as part of that discovery smoke test.
