import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { Account } from "./index";
import { flockExclusive } from "./os-lock";

export interface GistSyncConfig {
	gistId: string;
}

export interface SyncState {
	gistId: string;
	accounts: Account[];
}

/** Canonical shared state: usage/selection metadata never leaves this device. */
export function sharedAccounts(accounts: Account[]): Account[] {
	return accounts
		.map((a) => ({
			email: a.email,
			accessToken: a.accessToken,
			refreshToken: a.refreshToken,
			expiresAt: a.expiresAt,
			accountId: a.accountId,
		}))
		.sort((a, b) => a.email.localeCompare(b.email));
}

export function credentialsPending(
	local: Account[],
	acknowledged: Account[],
): boolean {
	return (
		JSON.stringify(sharedAccounts(local)) !==
		JSON.stringify(sharedAccounts(acknowledged))
	);
}

const equal = (a: unknown, b: unknown): boolean =>
	JSON.stringify(a) === JSON.stringify(b);

function credentials(account: Account | undefined): unknown {
	if (!account) return undefined;
	return [
		account.accessToken,
		account.refreshToken,
		account.expiresAt,
		account.accountId,
	];
}

/** Credentials are one indivisible value; never resolve divergent rotations by expiry. */
export function mergeAccounts(
	base: Account[],
	local: Account[],
	remote: Account[],
): Account[] {
	const result: Account[] = [];
	for (const email of new Set(
		[...local, ...remote, ...base].map((a) => a.email),
	)) {
		const b = base.find((a) => a.email === email);
		const l = local.find((a) => a.email === email);
		const r = remote.find((a) => a.email === email);
		let chosen: Account | undefined;
		if (equal(credentials(l), credentials(r))) chosen = l;
		else if (equal(credentials(l), credentials(b))) chosen = r;
		else if (equal(credentials(r), credentials(b))) chosen = l;
		else
			throw new Error(
				`Conflicting credentials for ${email}; no credentials overwritten. Re-login or reconcile manually.`,
			);
		if (chosen)
			result.push({
				...chosen,
				lastUsed: Math.max(l?.lastUsed ?? 0, r?.lastUsed ?? 0) || undefined,
			});
	}
	return result;
}

export class LockBusyError extends Error {}

/** Linux/macOS flock(2) ownership is retained by our descriptor.
 * Close releases it; process death does too. Never unlink these files:
 * that would create independent lock inodes.
 */
export function lockFile(file: string): () => void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const lock = `${file}.flock`;
	const fd = fs.openSync(
		lock,
		fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
		0o600,
	);
	try {
		if (!fs.fstatSync(fd).isFile())
			throw new Error("Lock must be a regular file");
		if (!flockExclusive(fd)) {
			throw new LockBusyError(`MultiCodex storage busy: ${lock}. Retry later.`);
		}
	} catch (error) {
		fs.closeSync(fd);
		if (error instanceof LockBusyError) throw error;
		throw new Error("Cannot acquire OS lock", { cause: error });
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		fs.closeSync(fd);
	};
}

export function atomicWrite(file: string, value: unknown): void {
	const temp = `${file}.${crypto.randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
		fs.renameSync(temp, file);
	} finally {
		fs.rmSync(temp, { force: true });
	}
}

export function validateAccounts(value: unknown): Account[] {
	if (!Array.isArray(value)) throw new Error("Invalid Gist accounts");
	const emails = new Set<string>();
	return value.map((a: Account) => {
		if (
			!a ||
			typeof a.email !== "string" ||
			!a.email ||
			emails.has(a.email) ||
			typeof a.accessToken !== "string" ||
			typeof a.refreshToken !== "string" ||
			!Number.isFinite(a.expiresAt) ||
			(a.accountId !== undefined && typeof a.accountId !== "string") ||
			(a.lastUsed !== undefined && !Number.isFinite(a.lastUsed))
		) {
			throw new Error("Invalid or duplicate Gist account");
		}
		emails.add(a.email);
		return {
			email: a.email,
			accessToken: a.accessToken,
			refreshToken: a.refreshToken,
			expiresAt: a.expiresAt,
			accountId: a.accountId,
			lastUsed: a.lastUsed,
		};
	});
}

const execute = promisify(execFile);

interface GistSummary {
	id: string;
	public: boolean;
	description: string;
	created_at: string;
	owner?: { id?: number };
	files?: Record<string, unknown>;
}

/** Stable selection across devices, including legacy duplicates. */
export function selectSharedGist(
	userId: number,
	gists: GistSummary[],
): string | undefined {
	const marker = `MultiCodex account sync (github:${userId})`;
	const candidates = gists.filter(
		(gist) =>
			gist.owner?.id === userId &&
			gist.public === false &&
			(gist.description === marker ||
				gist.description === "MultiCodex account sync") &&
			gist.files?.["multicodex.json"] !== undefined &&
			/^[a-f0-9]+$/i.test(gist.id) &&
			Number.isFinite(Date.parse(gist.created_at)),
	);
	candidates.sort(
		(a, b) =>
			Date.parse(a.created_at) - Date.parse(b.created_at) ||
			a.id.localeCompare(b.id),
	);
	return candidates[0]?.id;
}

/** Discover by authenticated numeric GitHub identity; create only when absent. */
export async function createSecretGist(): Promise<string> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicodex-gist-create-"));
	fs.chmodSync(dir, 0o700);
	try {
		// Use gh's existing login and configure Git credentials without manual setup.
		await execute("gh", ["auth", "setup-git", "--hostname", "github.com"], {
			timeout: 30_000,
		});
		const api = async (...args: string[]): Promise<string> => {
			const { stdout } = await execute(
				"gh",
				["api", "--hostname", "github.com", ...args],
				{
					timeout: 30_000,
					maxBuffer: 16 * 1024 * 1024,
				},
			);
			return stdout;
		};
		const user = JSON.parse(await api("user")) as { id?: number };
		if (!Number.isSafeInteger(user.id) || (user.id ?? 0) <= 0)
			throw new Error("Invalid GitHub identity");
		const userId = user.id as number;
		const discover = async (): Promise<string | undefined> => {
			const gists: GistSummary[] = [];
			for (let page = 1; ; page++) {
				const entries = JSON.parse(
					await api(`gists?per_page=100&page=${page}`),
				) as GistSummary[];
				if (!Array.isArray(entries)) throw new Error("Invalid Gist listing");
				gists.push(...entries);
				if (entries.length < 100) return selectSharedGist(userId, gists);
				if (page >= 1000)
					throw new Error("Gist listing too large to discover safely");
			}
		};
		const existing = await discover();
		if (existing) return existing;
		const input = path.join(dir, "request.json");
		atomicWrite(input, {
			description: `MultiCodex account sync (github:${userId})`,
			public: false,
			files: { "multicodex.json": { content: '{"accounts":[]}' } },
		});
		const { stdout } = await execute(
			"gh",
			[
				"api",
				"--hostname",
				"github.com",
				"--method",
				"POST",
				"gists",
				"--input",
				input,
			],
			{ timeout: 30_000, maxBuffer: 1024 * 1024 },
		);
		const gist = JSON.parse(stdout) as { id?: unknown; public?: unknown };
		if (
			typeof gist.id !== "string" ||
			!/^[a-f0-9]+$/i.test(gist.id) ||
			gist.public !== false
		) {
			throw new Error("Invalid secret Gist response");
		}
		// Creation has no cross-device uniqueness primitive. Re-list after POST
		// and on every subsequent sync so simultaneous creators converge safely.
		return (await discover()) ?? gist.id;
	} catch {
		throw new Error(
			"Could not discover or create a shared secret Gist. Install gh and run gh auth login with Gist access. If the request timed out, check your Gists before retrying; an empty Gist may have been created.",
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Each invocation has an isolated checkout; push is deliberately never forced. */
export async function syncGist(
	config: GistSyncConfig,
	base: Account[],
	local: Account[],
	options?: { pullOnly?: boolean },
): Promise<Account[]> {
	if (!/^[a-f0-9]+$/i.test(config.gistId))
		throw new Error("gistSync.gistId must be a Gist ID");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicodex-gist-"));
	fs.chmodSync(dir, 0o700);
	const git = async (...args: string[]): Promise<string> => {
		try {
			const { stdout } = await execute("git", args, {
				cwd: dir,
				timeout: 30_000,
				maxBuffer: 4 * 1024 * 1024,
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			});
			return stdout.trim();
		} catch {
			// Do not expose command output: it can contain credential-bearing URLs.
			throw new Error(
				"Gist Git operation failed (authentication, network, or concurrent update). Nothing was force-pushed; retry sync.",
			);
		}
	};
	try {
		await git(
			"clone",
			"--quiet",
			`https://gist.github.com/${config.gistId}.git`,
			".",
		);
		const file = path.join(dir, "multicodex.json");
		if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) {
			throw new Error("Gist multicodex.json must be a regular file");
		}
		const remote = fs.existsSync(file)
			? validateAccounts(
					(JSON.parse(fs.readFileSync(file, "utf8")) as { accounts?: unknown })
						.accounts,
				)
			: [];
		if (options?.pullOnly) return remote;
		const merged = mergeAccounts(base, local, remote);
		atomicWrite(file, { accounts: sharedAccounts(merged) });
		await git("add", "--", "multicodex.json");
		if (await git("diff", "--cached", "--name-only")) {
			await git(
				"-c",
				"user.name=MultiCodex",
				"-c",
				"user.email=multicodex@localhost",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--quiet",
				"-m",
				"Sync MultiCodex accounts",
			);
			await git("push", "--quiet", "origin", "HEAD");
		}
		return merged;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
