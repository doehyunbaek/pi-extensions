import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { refreshOpenAICodexToken } from "@mariozechner/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai/oauth", () => ({
	loginOpenAICodex: vi.fn(),
	refreshOpenAICodexToken: vi.fn(),
}));

vi.mock("./gist-sync", async (original) => ({
	...(await original<typeof import("./gist-sync")>()),
	syncGist: vi.fn(),
	createSecretGist: vi.fn(),
}));

import {
	createSecretGist,
	credentialsPending,
	lockFile,
	mergeAccounts,
	selectSharedGist,
	syncGist,
	validateAccounts,
} from "./gist-sync";
import { type Account, AccountManager } from "./index";

// Exercise native locking in independent processes without a flock executable.
const childLockScript = `
	const fs = require('node:fs');
	const koffi = require('koffi');
	const fd = fs.openSync(process.argv[1], 'a+', 0o600);
	const flock = koffi.load(null).func('int flock(int fd, int operation)');
	if (flock(fd, 2 | 4) !== 0) process.exit(75);
	if (process.argv[2] === 'hold') {
		process.stdout.write('ready');
		setInterval(() => {}, 1000);
	} else {
		fs.closeSync(fd);
	}
`;

const account = (email: string, token = "one"): Account => ({
	email,
	accessToken: token,
	refreshToken: token,
	expiresAt: Date.now() + 3_600_000,
});

describe("shared GitHub identity discovery", () => {
	const gist = (
		id: string,
		created_at: string,
		description = "MultiCodex account sync",
	) => ({
		id,
		created_at,
		description,
		public: false,
		owner: { id: 123 },
		files: { "multicodex.json": {} },
	});
	it("selects the same oldest legacy duplicate regardless of list order", () => {
		const older = gist("abc", "2026-01-01T00:00:00Z");
		const newer = gist(
			"def",
			"2026-02-01T00:00:00Z",
			"MultiCodex account sync (github:123)",
		);
		expect(selectSharedGist(123, [newer, older])).toBe("abc");
		expect(selectSharedGist(123, [older, newer])).toBe("abc");
	});
	it("never discovers another owner's, public, or unrelated Gist", () => {
		const candidate = gist("abc", "2026-01-01T00:00:00Z");
		expect(
			selectSharedGist(123, [
				{ ...candidate, owner: { id: 456 } },
				{ ...candidate, public: true },
				{ ...candidate, description: "unrelated" },
				{ ...candidate, description: "MultiCodex account sync (github:456)" },
			]),
		).toBeUndefined();
	});
});

describe("conservative account merging", () => {
	it("preserves independent additions and last-used updates", () => {
		const a = account("a");
		const b = account("b");
		expect(mergeAccounts([a], [{ ...a, lastUsed: 20 }], [a, b])).toEqual([
			{ ...a, lastUsed: 20 },
			{ ...b, lastUsed: undefined },
		]);
	});
	it("accepts a one-sided credential rotation", () => {
		const a = account("a");
		const rotated = { ...a, accessToken: "two", refreshToken: "two" };
		expect(mergeAccounts([a], [a], [rotated])[0]).toMatchObject(rotated);
	});
	it("rejects divergent rotations even when expiry is later", () => {
		const a = account("a");
		expect(() =>
			mergeAccounts(
				[a],
				[{ ...a, refreshToken: "two" }],
				[{ ...a, refreshToken: "three", expiresAt: a.expiresAt + 1000 }],
			),
		).toThrow("Conflicting credentials");
	});
	it("does not resurrect deletions and rejects delete-vs-update", () => {
		const a = account("a");
		expect(mergeAccounts([a], [], [a])).toEqual([]);
		expect(() =>
			mergeAccounts([a], [], [{ ...a, refreshToken: "two" }]),
		).toThrow();
	});
	it("rejects malformed remote accounts", () => {
		expect(() => validateAccounts(null)).toThrow();
		expect(() => validateAccounts([account("a"), account("a")])).toThrow();
		expect(() => validateAccounts([{}])).toThrow();
	});
});

describe("local sync concurrency", () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicodex-sync-test-"));
		file = path.join(dir, "multicodex.json");
		vi.stubEnv("MULTICODEX_STORAGE_FILE", file);
		vi.stubEnv("MULTICODEX_DISABLE_LOG", "1");
		fs.writeFileSync(
			file,
			JSON.stringify({ accounts: [account("a")], gistSync: { gistId: "abc" } }),
		);
		vi.mocked(syncGist).mockReset();
		vi.mocked(createSecretGist).mockReset().mockResolvedValue("abc");
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	it("ignores lastUsed and ordering when detecting pending credentials", () => {
		const a = account("a");
		const b = account("b");
		expect(credentialsPending([{ ...a, lastUsed: 5 }, b], [b, a])).toBe(false);
		expect(credentialsPending([{ ...a, refreshToken: "new" }], [a])).toBe(true);
		expect(credentialsPending([], [a])).toBe(true);
	});

	it("recovers durable pending work at startup and persists retries across restart", async () => {
		vi.useFakeTimers();
		vi.mocked(syncGist)
			.mockRejectedValueOnce(new Error("secret must not be stored"))
			.mockImplementation(async (_config, _base, local) => local);
		const one = new AccountManager();
		one.startSync();
		expect(one.getSyncStatus()).toBe("pending");
		await vi.advanceTimersByTimeAsync(250);
		expect(one.getSyncStatus()).toContain("retrying");
		expect(fs.readFileSync(file, "utf8")).not.toContain(
			"secret must not be stored",
		);
		one.stopSync();
		const two = new AccountManager();
		two.startSync();
		await vi.advanceTimersByTimeAsync(3_000);
		expect(two.getSyncStatus()).toBe("synced");
		expect(two.getSyncStatus(true)).toContain("last success");
		expect(createSecretGist).not.toHaveBeenCalled();
		two.stopSync();
	});

	it("queues a login saved during upload and keeps lastUsed local on pull", async () => {
		vi.useFakeTimers();
		const manager = new AccountManager();
		let finish!: (accounts: Account[]) => void;
		vi.mocked(syncGist)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			)
			.mockImplementation(async (_config, _base, local) => local);
		manager.startSync();
		await vi.advanceTimersByTimeAsync(250);
		const uploaded = JSON.parse(fs.readFileSync(file, "utf8")).accounts;
		manager.addOrUpdateAccount("b", {
			access: "b",
			refresh: "b",
			expires: Date.now() + 100_000,
		});
		finish(uploaded);
		await vi.advanceTimersByTimeAsync(500);
		expect(manager.getSyncStatus()).toBe("synced");
		expect(syncGist).toHaveBeenCalledTimes(2);
		manager.stopSync();
		const before = manager.getAccount("b")?.lastUsed;
		vi.mocked(syncGist).mockResolvedValue(
			manager.getAccounts().map((a) => ({ ...a, lastUsed: Date.now() + 9999 })),
		);
		await manager.pullAccounts();
		expect(manager.getAccount("b")?.lastUsed).toBe(before);
	});

	it("halts on conflicts until explicit retry and stops timers on shutdown", async () => {
		vi.useFakeTimers();
		vi.mocked(syncGist).mockRejectedValue(
			new Error("Conflicting credentials for a"),
		);
		const manager = new AccountManager();
		manager.startSync();
		await vi.advanceTimersByTimeAsync(250);
		expect(manager.getSyncStatus()).toContain("conflict");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(syncGist).toHaveBeenCalledTimes(1);
		vi.mocked(syncGist).mockImplementation(
			async (_config, _base, local) => local,
		);
		await manager.syncAccounts();
		expect(manager.getSyncStatus()).toBe("synced");
		manager.stopSync();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(syncGist).toHaveBeenCalledTimes(2);
	});

	it("retries lock contention and honors opt-out before a scheduled upload", async () => {
		vi.useFakeTimers();
		const manager = new AccountManager();
		const release = lockFile(`${file}.gist-sync`);
		manager.startSync();
		await vi.advanceTimersByTimeAsync(250);
		expect(manager.getSyncStatus()).toContain("retrying");
		expect(syncGist).not.toHaveBeenCalled();
		release();
		const disk = JSON.parse(fs.readFileSync(file, "utf8"));
		delete disk.gistSync;
		fs.writeFileSync(file, JSON.stringify(disk));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(syncGist).not.toHaveBeenCalled();
		expect(createSecretGist).not.toHaveBeenCalled();
		manager.stopSync();
	});

	it("never opts in automatically", async () => {
		vi.useFakeTimers();
		fs.writeFileSync(file, JSON.stringify({ accounts: [account("a")] }));
		const manager = new AccountManager();
		manager.startSync();
		manager.addOrUpdateAccount("b", {
			access: "b",
			refresh: "b",
			expires: Date.now() + 100_000,
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(manager.getSyncStatus()).toBe("disabled");
		expect(syncGist).not.toHaveBeenCalled();
		manager.stopSync();
	});

	it("creates and persists an ID before syncing, preserving a concurrent login", async () => {
		fs.writeFileSync(file, JSON.stringify({ accounts: [] }));
		let finish!: (id: string) => void;
		vi.mocked(createSecretGist).mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		vi.mocked(syncGist).mockImplementation(async (_config, _base, accounts) => {
			expect(JSON.parse(fs.readFileSync(file, "utf8")).gistSync.gistId).toBe(
				"abc",
			);
			return accounts;
		});
		const manager = new AccountManager();
		const pending = manager.syncAccounts();
		expect(manager.syncAccounts()).toBe(pending);
		await expect(new AccountManager().syncAccounts()).rejects.toThrow("busy");
		manager.addOrUpdateAccount("b", {
			access: "b",
			refresh: "b",
			expires: Date.now() + 3_600_000,
		});
		finish("abc");
		await pending;
		expect(manager.getAccount("b")).toBeDefined();
		expect(createSecretGist).toHaveBeenCalledTimes(1);
	});

	it("rediscovers the same shared Gist after the first push fails", async () => {
		fs.writeFileSync(file, JSON.stringify({ accounts: [] }));
		vi.mocked(createSecretGist).mockResolvedValue("abc");
		vi.mocked(syncGist)
			.mockRejectedValueOnce(new Error("push failed"))
			.mockResolvedValueOnce([]);
		const manager = new AccountManager();
		await expect(manager.syncAccounts()).rejects.toThrow("push failed");
		await manager.syncAccounts();
		expect(createSecretGist).toHaveBeenCalledTimes(2);
	});

	it("does not replace configuration edited during creation", async () => {
		fs.writeFileSync(file, JSON.stringify({ accounts: [] }));
		vi.mocked(createSecretGist).mockImplementation(async () => {
			fs.writeFileSync(
				file,
				JSON.stringify({ accounts: [], gistSync: { gistId: "def" } }),
			);
			return "abc";
		});
		await expect(new AccountManager().syncAccounts()).rejects.toThrow(
			"Resolved shared secret Gist abc",
		);
		expect(JSON.parse(fs.readFileSync(file, "utf8")).gistSync.gistId).toBe(
			"def",
		);
		expect(syncGist).not.toHaveBeenCalled();
	});

	it("converges an existing configured duplicate onto the shared Gist", async () => {
		const a = account("a");
		fs.writeFileSync(
			file,
			JSON.stringify({
				accounts: [a],
				gistSync: { gistId: "def" },
				gistSyncState: { gistId: "def", accounts: [a] },
			}),
		);
		vi.mocked(syncGist).mockResolvedValue([a]);
		await new AccountManager().syncAccounts();
		expect(syncGist).toHaveBeenCalledWith({ gistId: "abc" }, [], [a]);
		expect(JSON.parse(fs.readFileSync(file, "utf8")).gistSync.gistId).toBe(
			"abc",
		);
	});

	it("uploads a refresh occurring during manual sync in a follow-up pass", async () => {
		const a = { ...account("a"), expiresAt: 0 };
		fs.writeFileSync(
			file,
			JSON.stringify({ accounts: [a], gistSync: { gistId: "abc" } }),
		);
		let finish!: (accounts: Account[]) => void;
		vi.mocked(syncGist)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			)
			.mockImplementation(async (_config, _base, local) => local);
		vi.mocked(refreshOpenAICodexToken).mockResolvedValue({
			access: "rotated",
			refresh: "rotated",
			expires: Date.now() + 3_600_000,
		});
		vi.stubEnv("MULTICODEX_LOCK_DIR", path.join(dir, "refresh-locks"));
		const manager = new AccountManager();
		manager.startSync();
		const manual = manager.syncAccounts();
		await vi.waitFor(() => expect(syncGist).toHaveBeenCalledTimes(1));
		const refresh = manager.ensureValidToken(
			manager.getAccount("a") as Account,
		);
		expect(syncGist).toHaveBeenCalledTimes(1);
		finish([a]);
		await manual;
		await expect(refresh).resolves.toBe("rotated");
		await vi.waitFor(() => expect(syncGist).toHaveBeenCalledTimes(3));
		expect(vi.mocked(syncGist).mock.calls[1][3]).toEqual({ pullOnly: true });
		expect(vi.mocked(syncGist).mock.calls[2][2][0].refreshToken).toBe(
			"rotated",
		);
		await manager.syncAccounts();
		manager.stopSync();
	});

	it("pulls a remote rotation using the saved baseline and updates it atomically", async () => {
		const a = account("a");
		const rotated = { ...a, accessToken: "remote", refreshToken: "remote" };
		fs.writeFileSync(
			file,
			JSON.stringify({
				accounts: [a],
				gistSync: { gistId: "abc" },
				gistSyncState: { gistId: "abc", accounts: [a] },
			}),
		);
		vi.mocked(syncGist).mockResolvedValue([rotated]);
		const manager = new AccountManager();
		await manager.pullAccounts();
		expect(manager.getAccount("a")?.refreshToken).toBe("remote");
		expect(syncGist).toHaveBeenCalledWith({ gistId: "abc" }, [a], [a], {
			pullOnly: true,
		});
		expect(createSecretGist).not.toHaveBeenCalled();
		expect(
			JSON.parse(fs.readFileSync(file, "utf8")).gistSyncState.accounts[0]
				.refreshToken,
		).toBe("remote");
	});

	it("rejects a conflicting login during pull without changing its credentials or baseline", async () => {
		const a = account("a");
		fs.writeFileSync(
			file,
			JSON.stringify({
				accounts: [a],
				gistSync: { gistId: "abc" },
				gistSyncState: { gistId: "abc", accounts: [a] },
			}),
		);
		let finish!: (accounts: Account[]) => void;
		vi.mocked(syncGist).mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const manager = new AccountManager();
		const pull = manager.pullAccounts();
		await vi.waitFor(() => expect(syncGist).toHaveBeenCalledTimes(1));
		manager.addOrUpdateAccount("a", {
			access: "login",
			refresh: "login",
			expires: a.expiresAt,
		});
		finish([{ ...a, accessToken: "remote", refreshToken: "remote" }]);
		await expect(pull).rejects.toThrow("Conflicting credentials");
		const disk = JSON.parse(fs.readFileSync(file, "utf8"));
		expect(disk.accounts[0].refreshToken).toBe("login");
		expect(disk.gistSyncState.accounts[0].refreshToken).toBe(a.refreshToken);
		expect(fs.existsSync(`${file}.gist-sync.lock`)).toBe(false);
	});

	it("holds a descriptor lock across processes and leaves a reusable inode after release", () => {
		const release = lockFile(file);
		const inode = fs.statSync(`${file}.flock`).ino;
		expect(() =>
			execFileSync(process.execPath, ["-e", childLockScript, `${file}.flock`]),
		).toThrow();
		release();
		release();
		execFileSync(process.execPath, ["-e", childLockScript, `${file}.flock`]);
		const again = lockFile(file);
		again();
		expect(fs.statSync(`${file}.flock`).ino).toBe(inode);
	});

	it("releases ownership after SIGKILL without deleting the lock file", async () => {
		const child = spawn(
			process.execPath,
			["-e", childLockScript, `${file}.flock`, "hold"],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		try {
			await once(child.stdout, "data");
			expect(() => lockFile(file)).toThrow("busy");
			child.kill("SIGSTOP");
			expect(() => lockFile(file)).toThrow("busy");
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
			const release = lockFile(file);
			release();
			expect(fs.existsSync(`${file}.flock`)).toBe(true);
		} finally {
			child.kill("SIGKILL");
		}
	});

	it("never steals an old local lock", () => {
		const release = lockFile(file);
		fs.utimesSync(`${file}.flock`, new Date(0), new Date(0));
		expect(() => lockFile(file)).toThrow("busy");
		release();
	});
	it("merges stale managers without erasing accounts or config", () => {
		const one = new AccountManager();
		const two = new AccountManager();
		one.addOrUpdateAccount("b", {
			access: "b",
			refresh: "b",
			expires: Date.now() + 3_600_000,
		});
		two.setActiveAccount("a");
		const disk = JSON.parse(fs.readFileSync(file, "utf8"));
		expect(disk.accounts.map((a: Account) => a.email)).toEqual(["a", "b"]);
		expect(disk.gistSync).toEqual({ gistId: "abc" });
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	});
	it("shares in-process sync and rejects a second manager while preserving in-flight login", async () => {
		let finish!: (accounts: Account[]) => void;
		vi.mocked(syncGist).mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const one = new AccountManager();
		const two = new AccountManager();
		const pending = one.syncAccounts();
		expect(one.syncAccounts()).toBe(pending);
		await expect(two.syncAccounts()).rejects.toThrow("busy");
		two.addOrUpdateAccount("b", {
			access: "b",
			refresh: "b",
			expires: Date.now() + 3_600_000,
		});
		finish([account("a"), account("c")]);
		await pending;
		expect(one.getAccounts().map((a) => a.email)).toEqual(["a", "b", "c"]);
		expect(vi.mocked(syncGist)).toHaveBeenCalledTimes(1);
	});
	it("keeps accounts and baseline untouched after a remote failure", async () => {
		const before = fs.readFileSync(file, "utf8");
		vi.mocked(syncGist).mockRejectedValue(new Error("push rejected"));
		await expect(new AccountManager().syncAccounts()).rejects.toThrow(
			"push rejected",
		);
		const disk = JSON.parse(fs.readFileSync(file, "utf8"));
		expect(disk.accounts).toEqual(JSON.parse(before).accounts);
		expect(disk.gistSyncState).toEqual(JSON.parse(before).gistSyncState);
		expect(disk.gistSyncStatus.nextRetry).toBeGreaterThan(Date.now());
		expect(fs.existsSync(`${file}.gist-sync.lock`)).toBe(false);
	});
	it("does not overwrite an in-flight conflicting login", async () => {
		let finish!: (accounts: Account[]) => void;
		vi.mocked(syncGist).mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const manager = new AccountManager();
		const pending = manager.syncAccounts();
		await Promise.resolve();
		manager.addOrUpdateAccount("a", {
			access: "login",
			refresh: "login",
			expires: Date.now() + 3_600_000,
		});
		finish([account("a", "remote")]);
		await expect(pending).rejects.toThrow("Conflicting credentials");
		const disk = JSON.parse(fs.readFileSync(file, "utf8"));
		expect(disk.accounts[0].refreshToken).toBe("login");
		expect(disk.gistSyncState).toBeUndefined();
	});
});
