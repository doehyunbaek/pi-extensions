import assert from "node:assert/strict";
import { test } from "node:test";
import { accessLoginCommand, accessSignInUrl, missingAccessToken } from "./cloudflare-access.ts";

const app = "https://doehyunbaek.com/llm/";

test("constructs a quiet login for the configured Cloudflare app", () => {
  for (const bin of ["cloudflared", "/opt/homebrew/bin/cloudflared", "/home/doehyunbaek/.local/bin/cloudflared"]) {
    assert.deepEqual(accessLoginCommand(`!${bin} access token --app ${app}`), [bin, "access", "login", "--quiet", app]);
  }
});

test("does not rewrite shell expressions or other credential commands", () => {
  for (const value of [app, "!/bin/cat /some/key", `!cloudflared access token --app ${app}; echo nope`,
    "!cloudflared access token --app $APP", "!cloudflared access token --app http://example.com/"]) {
    assert.equal(accessLoginCommand(value), undefined);
  }
});

test("only surfaces HTTPS Cloudflare CLI sign-in URLs on the configured app origin", () => {
  const link = "https://doehyunbaek.com/cdn-cgi/access/cli?token=mock&aud=some-app";
  assert.equal(accessSignInUrl(link, app), link);
  for (const value of [link.replace("doehyunbaek.com", "example.com"), link.replace("https", "http"),
    link.replace("/cli", "/other"), link.replace("token=mock", "other=mock"), `${link}\x1b\\`]) {
    assert.equal(accessSignInUrl(value, app), undefined);
  }
});

test("distinguishes an absent token from an interrupted command or other failure", () => {
  const result = { stdout: "", stderr: "Unable to find token for provided application. Please run login command to generate token.", killed: false, truncated: false };
  assert.equal(missingAccessToken(result), true);
  assert.equal(missingAccessToken({ ...result, killed: true }), false);
  assert.equal(missingAccessToken({ ...result, truncated: true }), false);
  assert.equal(missingAccessToken({ ...result, stderr: "network error" }), false);
  assert.equal(missingAccessToken({ ...result, stdout: "mock credential" }), false);
});
