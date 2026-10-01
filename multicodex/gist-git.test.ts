import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { syncGist } from "./gist-sync";
import type { Account } from "./index";

let dir: string;
let remote: string;
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
const account = (email: string): Account => ({
	email,
	accessToken: email,
	refreshToken: email,
	expiresAt: 123,
});

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicodex-git-test-"));
	remote = path.join(dir, "remote.git");
	git(dir, "init", "--bare", "--initial-branch=main", remote);
	const seed = path.join(dir, "seed");
	fs.mkdirSync(seed);
	git(seed, "init", "--initial-branch=main");
	fs.writeFileSync(path.join(seed, "placeholder"), "seed");
	git(seed, "add", ".");
	git(
		seed,
		"-c",
		"user.name=test",
		"-c",
		"user.email=test@example.com",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"seed",
	);
	git(seed, "push", remote, "main");
	vi.stubEnv("GIT_CONFIG_COUNT", "1");
	vi.stubEnv("GIT_CONFIG_KEY_0", `url.${remote}.insteadOf`);
	vi.stubEnv("GIT_CONFIG_VALUE_0", "https://gist.github.com/abc.git");
});
afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

it("round-trips accounts through real Git without uploading local configuration", async () => {
	await syncGist({ gistId: "abc" }, [], [{ ...account("a"), lastUsed: 12345 }]);
	const pulled = await syncGist({ gistId: "abc" }, [], []);
	expect(pulled).toMatchObject([account("a")]);
	const contents = JSON.parse(
		git(dir, "--git-dir", remote, "show", "main:multicodex.json"),
	);
	expect(Object.keys(contents)).toEqual(["accounts"]);
	expect(contents.accounts[0]).not.toHaveProperty("lastUsed");
	const before = git(dir, "--git-dir", remote, "rev-parse", "main");
	await syncGist({ gistId: "abc" }, pulled, [
		{ ...account("a"), lastUsed: 99999 },
	]);
	expect(git(dir, "--git-dir", remote, "rev-parse", "main")).toBe(before);
});

it("pulls remote credentials without pushing local changes", async () => {
	await syncGist({ gistId: "abc" }, [], [account("a")]);
	const before = git(dir, "--git-dir", remote, "rev-parse", "main");
	const pulled = await syncGist({ gistId: "abc" }, [], [account("b")], {
		pullOnly: true,
	});
	expect(pulled).toMatchObject([account("a")]);
	expect(git(dir, "--git-dir", remote, "rev-parse", "main")).toBe(before);
});

it("rejects one of two simultaneous divergent pushes without losing the winner", async () => {
	const hooks = path.join(dir, "hooks");
	const arrivals = path.join(dir, "arrivals");
	fs.mkdirSync(hooks);
	fs.mkdirSync(arrivals);
	fs.writeFileSync(
		path.join(hooks, "pre-push"),
		`#!/bin/sh\ntouch '${arrivals}'/$$\ni=0\nwhile [ "$(ls '${arrivals}' | wc -l)" -lt 2 ]; do\n  i=$((i+1)); [ "$i" -gt 100 ] && exit 1\n  sleep 0.05\ndone\n`,
		{ mode: 0o700 },
	);
	vi.stubEnv("GIT_CONFIG_COUNT", "2");
	vi.stubEnv("GIT_CONFIG_KEY_1", "core.hooksPath");
	vi.stubEnv("GIT_CONFIG_VALUE_1", hooks);
	const results = await Promise.allSettled([
		syncGist({ gistId: "abc" }, [], [account("a")]),
		syncGist({ gistId: "abc" }, [], [account("b")]),
	]);
	expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
	const contents = JSON.parse(
		git(dir, "--git-dir", remote, "show", "main:multicodex.json"),
	);
	const winner = results.find((r) => r.status === "fulfilled");
	if (winner?.status !== "fulfilled") throw new Error("No winner");
	expect(contents.accounts[0].email).toBe(winner.value[0].email);
});
