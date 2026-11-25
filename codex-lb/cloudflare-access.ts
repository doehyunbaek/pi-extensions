import { spawn } from "node:child_process";

/** Recognize only the simple cloudflared form, never rewrite arbitrary shell commands. */
export function accessLoginCommand(value: string): string[] | undefined {
  const match = /^!((?:\/[\w.+-]+)*\/cloudflared|cloudflared)[ \t]+access[ \t]+token[ \t]+--app[ \t]+(https:\/\/[\w.:%/~-]+)$/.exec(value);
  if (!match) return;
  try { new URL(match[2]); } catch { return; }
  return [match[1], "access", "login", "--quiet", match[2]];
}

export function missingAccessToken(result: { stdout: string; stderr: string; killed: boolean; truncated: boolean }): boolean {
  return !result.killed && !result.truncated && !result.stdout.trim() &&
    result.stderr.includes("Unable to find token for provided application");
}

export class AccessLoginRequired extends Error {}

export function accessSignInUrl(line: string, app: string): string | undefined {
  if (!/^https:\/\/[\x21-\x7e]+$/.test(line)) return;
  try {
    const url = new URL(line);
    if (url.origin === new URL(app).origin && url.pathname === "/cdn-cgi/access/cli" &&
      !url.username && !url.password && url.searchParams.get("token")) return url.href;
  } catch { /* Ignore unrelated output. */ }
}

type LoginStatus = { state: "starting" | "done" | "failed" } | { state: "link"; url: string };

export function createAccessLogin() {
  let running: Promise<boolean> | undefined;
  let stopHeadless: (() => void) | undefined;
  return {
    stop() { stopHeadless?.(); },
    async request(command: string[], show?: (status: LoginStatus) => void): Promise<AccessLoginRequired> {
      const desktop = !process.env.SSH_CONNECTION && !process.env.SSH_TTY &&
        (process.platform === "darwin" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY));
      const headlessUi = desktop ? undefined : show;
      if ((desktop || headlessUi) && !running) {
        // Never put the login link or child output in the provider error/session transcript.
        const child = spawn(command[0], command.slice(1), {
          detached: desktop,
          stdio: ["ignore", "ignore", headlessUi ? "pipe" : "ignore"],
        });
        running = new Promise(resolve => {
          child.once("spawn", () => resolve(true));
          child.once("error", () => resolve(false));
        });
        child.once("close", code => {
          running = undefined;
          stopHeadless = undefined;
          headlessUi?.({ state: code === 0 ? "done" : "failed" });
        });
        if (headlessUi) {
          stopHeadless = () => { child.kill(); };
          headlessUi({ state: "starting" });
          let pending = "";
          child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
            const lines = (pending + chunk).split("\n");
            pending = lines.pop()!.slice(-8192);
            for (const line of lines) {
              const url = accessSignInUrl(line.replace(/\r$/, ""), command.at(-1)!);
              if (url) headlessUi({ state: "link", url });
            }
          });
        } else {
          // The desktop browser flow must outlive the failed request.
          child.unref();
        }
      }
      const manual = `Run ${command.join(" ")} in a terminal and open the sign-in link it prints.`;
      const started = (desktop || headlessUi) && await running;
      const action = started
        ? `Complete sign-in ${desktop ? "in your browser" : "using the link above the Pi prompt"}, then retry. If no link or window appears: ${manual}`
        : `${manual} Then retry.`;
      return new AccessLoginRequired(`codex-lb: Cloudflare Access token expired or missing. ${action}`);
    },
  };
}
