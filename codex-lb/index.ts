import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProvider, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseCatalog, PROVIDER } from "./catalog.ts";
import { AccessLoginRequired, accessLoginCommand, createAccessLogin, missingAccessToken } from "./cloudflare-access.ts";

/** Reuse trusted global models.json endpoint/auth configuration; never write credentials. */
export default async function (pi: ExtensionAPI) {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const config = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")).providers?.[PROVIDER];
  if (!config?.baseUrl || !config?.apiKey) {
    throw new Error(`codex-lb: configure ${PROVIDER}.baseUrl and apiKey in models.json first`);
  }
  const baseUrl: string = config.baseUrl.replace(/\/+$/, "");
  const accessLogin = createAccessLogin();
  let terminalUI: ExtensionContext["ui"] | undefined;
  const loginWidget = "codex-lb-access-login";
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") terminalUI = ctx.ui;
  });
  pi.on("session_shutdown", () => {
    terminalUI?.setWidget(loginWidget, undefined);
    terminalUI = undefined;
    accessLogin.stop();
  });
  // Commands originate only in the user's trusted global configuration.
  async function resolve(value: string, signal: AbortSignal, accessHeader = false): Promise<string> {
    signal.throwIfAborted();
    if (value.startsWith("!")) {
      const result = await pi.exec("/bin/sh", ["-c", value.slice(1)], { signal, timeout: 15000, maxBuffer: 65536 });
      signal.throwIfAborted();
      const login = accessHeader ? accessLoginCommand(value) : undefined;
      if (login && missingAccessToken(result)) {
        throw await accessLogin.request(login, terminalUI && (status => {
          if (!terminalUI) return;
          if (status.state === "link") {
            const link = `\x1b]8;;${status.url}\x1b\\\x1b[4mSign in to Cloudflare Access\x1b[24m\x1b]8;;\x1b\\`;
            terminalUI.setWidget(loginWidget, [link, "Open the link in your local browser, then retry your prompt."]);
          } else if (status.state === "starting") {
            terminalUI.setWidget(loginWidget, ["Cloudflare Access: waiting for a sign-in link…"]);
          } else {
            terminalUI.setWidget(loginWidget, undefined);
            terminalUI.notify(status.state === "done" ? "Cloudflare Access sign-in complete. Retry your prompt." :
              `Cloudflare Access sign-in ended. Retry or run ${login.join(" ")}.`, status.state === "done" ? "info" : "warning");
          }
        }));
      }
      if (result.code !== 0 || result.truncated || (login && !result.stdout.trim())) {
        throw new Error("codex-lb: authentication command failed");
      }
      return result.stdout.trim();
    }
    return value.replace(/\$\$|\$!|\$\{([A-Za-z_][A-Za-z_0-9]*)\}|\$([A-Za-z_][A-Za-z_0-9]*)/g,
      (match, braced, bare) => match === "$$" ? "$" : match === "$!" ? "!" : process.env[braced ?? bare] ?? "");
  }
  async function authentication(signal: AbortSignal, key?: string) {
    const apiKey = key ?? await resolve(config.apiKey, signal);
    if (!apiKey) throw new Error("codex-lb: API key is empty");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(config.headers ?? {})) {
      headers[name] = await resolve(String(value), signal, name.toLowerCase() === "cf-access-token");
    }
    return { apiKey, headers };
  }
  const provider = createProvider({
    id: PROVIDER,
    name: "Codex LB",
    baseUrl,
    models: [],
    api: openAIResponsesApi(),
    auth: {
      apiKey: {
        name: "Codex LB API key",
        async check() { return { type: "api_key", source: "models.json" }; },
        async resolve({ credential, signal }) {
          return { auth: await authentication(signal, credential?.key), source: "models.json" };
        },
      },
    },
    // createProvider restores/persists the catalog through Pi's generation-checked model store.
    async fetchModels(context) {
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30000)]);
      const { apiKey, headers } = await authentication(signal,
        context.credential?.type === "api_key" ? context.credential.key : undefined);
      const endpoint = (context.baseUrl ?? baseUrl).replace(/\/+$/, "");
      const response = await fetch(`${endpoint}/models`, {
        headers: { ...headers, Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": "pi-codex-lb/1.0" },
        signal,
      });
      if (!response.ok) throw new Error(`codex-lb: model discovery failed (HTTP ${response.status})`);
      return parseCatalog(await response.json(), endpoint);
    },
  });
  // Seed before startup model selection (including --list-models and print mode).
  // Pi's ordinary model refresh remains responsible for subsequent discovery.
  const cachePath = join(agentDir, "codex-lb-models.json");
  let stored;
  try {
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    if (cache.baseUrl === baseUrl && Array.isArray(cache.entry?.models)) stored = cache.entry;
  } catch { /* First run or invalid cache: use live discovery. */ }
  try {
    await provider.refreshModels?.({
      stored, allowNetwork: true, baseUrl, signal: AbortSignal.timeout(30000),
      async publish({ persist, update }) {
        if (persist) {
          await mkdir(agentDir, { recursive: true });
          const temporary = `${cachePath}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, JSON.stringify({ baseUrl, entry: persist }), { mode: 0o600 });
            await rename(temporary, cachePath);
          } finally { await unlink(temporary).catch(() => {}); }
        }
        update?.();
        return true;
      },
    });
  } catch (error) {
    if (provider.getModels().length === 0) {
      if (error instanceof AccessLoginRequired) throw error;
      throw new Error("codex-lb: discovery failed and no cached models are available; check gateway authentication");
    }
    // Keep the restored catalog when offline. Runtime refresh reports later failures.
  }
  pi.registerProvider(provider);
  pi.registerCommand("codex-lb-refresh", {
    description: "Refresh models from the Codex LB gateway",
    async handler(_args, ctx) {
      const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER], allowNetwork: true, force: true });
      const error = result.errors.get(PROVIDER);
      ctx.ui.notify(error ? error.message : `Codex LB: ${ctx.modelRegistry.getProvider(PROVIDER)?.getModels().length ?? 0} models`, error ? "error" : "info");
    },
  });
}
