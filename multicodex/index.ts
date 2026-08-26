/*
 * MultiCodex Extension
 *
 * Rotates multiple ChatGPT Codex OAuth accounts by exposing a dedicated
 * MultiCodex API wrapper around Pi's built-in openai-codex-responses API.
 *
 * Note: The published @mariozechner/pi-coding-agent types do not expose the
 * extension surface yet. We import ExtensionAPI as a type and provide a local
 * module augmentation (pi-coding-agent.d.ts) so TypeScript can compile.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	getApiProvider,
	getModels,
	type Model,
	type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import {
	loginOpenAICodex,
	refreshOpenAICodexToken,
} from "./openai-codex-oauth";

// =============================================================================
// Helpers
// =============================================================================

const USAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const USAGE_REQUEST_TIMEOUT_MS = 10 * 1000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_LOCK_WAIT_MS = 60 * 1000;
const TOKEN_REFRESH_LOCK_STALE_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_LOCK_POLL_MS = 250;
const TOKEN_REFRESH_LOCK_DIR = path.join(
	os.homedir(),
	".pi",
	"agent",
	"multicodex-refresh-locks",
);
const LOG_FILE = path.join(os.homedir(), ".pi", "agent", "multicodex.log");
const USAGE_LOG_FILE = path.join(
	os.homedir(),
	".pi",
	"agent",
	"multicodex-usage.jsonl",
);

function getMulticodexStorageFile(): string {
	return process.env.MULTICODEX_STORAGE_FILE || STORAGE_FILE;
}

function getMulticodexLogFile(): string | undefined {
	if (process.env.MULTICODEX_DISABLE_LOG === "1") return undefined;
	return process.env.MULTICODEX_LOG_FILE || LOG_FILE;
}

function getMulticodexUsageLogFile(): string | undefined {
	if (process.env.MULTICODEX_DISABLE_USAGE_LOG === "1") return undefined;
	return process.env.MULTICODEX_USAGE_LOG_FILE || USAGE_LOG_FILE;
}

function redactLogString(value: string): string {
	return value.replace(
		/(access_token|refresh_token|id_token|api[-_]?key|authorization|password|secret)(["'\s:=]+)([^"'\s,&}]+)/gi,
		"$1$2[redacted]",
	);
}

function safeLogJson(details: Record<string, unknown>): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(details, (key, value: unknown) => {
		if (/token|authorization|api[-_]?key|secret|password/i.test(key)) {
			return "[redacted]";
		}
		if (value instanceof Error) {
			return {
				name: value.name,
				message: redactLogString(value.message),
				stack: value.stack ? redactLogString(value.stack) : undefined,
			};
		}
		if (typeof value === "string") return redactLogString(value);
		if (typeof value === "bigint") return value.toString();
		if (typeof value === "object" && value !== null) {
			if (seen.has(value)) return "[circular]";
			seen.add(value);
		}
		return value;
	});
}

function logMulticodex(
	message: string,
	details?: Record<string, unknown>,
): void {
	try {
		const logFile = getMulticodexLogFile();
		if (!logFile) return;
		const dir = path.dirname(logFile);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		const suffix = details ? ` ${safeLogJson(details)}` : "";
		fs.appendFileSync(
			logFile,
			`${new Date().toISOString()} pid=${process.pid} ${message}${suffix}\n`,
		);
	} catch (error) {
		console.error("Failed to write multicodex log:", error);
	}
}

export function writeUsageLedgerEvent(event: Record<string, unknown>): void {
	try {
		const logFile = getMulticodexUsageLogFile();
		if (!logFile) return;
		fs.mkdirSync(path.dirname(logFile), { recursive: true });
		fs.appendFileSync(
			logFile,
			`${JSON.stringify({ version: 1, ...event })}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
	} catch (error) {
		logMulticodex("usage_ledger.write.failure", { error });
	}
}

export interface DailyUsage {
	requests: number;
	tokens: number;
}

export interface UsageLedgerAnalysis {
	accounts: string[];
	byAccount: Map<string, Map<string, DailyUsage>>;
}

function localDateKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function readUsageLedgerAnalysis(
	logFile = getMulticodexUsageLogFile(),
): UsageLedgerAnalysis {
	const byAccount = new Map<string, Map<string, DailyUsage>>();
	if (!logFile || !fs.existsSync(logFile)) return { accounts: [], byAccount };

	for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line) as {
				type?: unknown;
				timestamp?: unknown;
				account?: unknown;
				usage?: { totalTokens?: unknown; input?: unknown; output?: unknown };
			};
			if (
				record.type !== "request" ||
				typeof record.account !== "string" ||
				typeof record.timestamp !== "string"
			) {
				continue;
			}
			const timestamp = new Date(record.timestamp);
			if (!Number.isFinite(timestamp.getTime())) continue;
			const totalTokens = record.usage?.totalTokens;
			const fallbackTokens =
				Number(record.usage?.input ?? 0) + Number(record.usage?.output ?? 0);
			const tokens = Number.isFinite(Number(totalTokens))
				? Math.max(0, Number(totalTokens))
				: Number.isFinite(fallbackTokens)
					? Math.max(0, fallbackTokens)
					: 0;
			const accountDays = byAccount.get(record.account) ?? new Map();
			byAccount.set(record.account, accountDays);
			const key = localDateKey(timestamp);
			const current = accountDays.get(key) ?? { requests: 0, tokens: 0 };
			current.requests += 1;
			current.tokens += tokens;
			accountDays.set(key, current);
		} catch {
			// A partially written or old unknown record should not hide valid history.
		}
	}
	return { accounts: [...byAccount.keys()], byAccount };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAccountLockId(email: string): string {
	return crypto.createHash("sha256").update(email).digest("hex").slice(0, 16);
}

function getTokenRefreshLockDir(): string {
	return process.env.MULTICODEX_LOCK_DIR || TOKEN_REFRESH_LOCK_DIR;
}

function getTokenRefreshLockPath(): string {
	return path.join(getTokenRefreshLockDir(), "token-refresh.lock");
}

function getErrnoCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

async function acquireTokenRefreshLock(email: string): Promise<() => void> {
	const lockPath = getTokenRefreshLockPath();
	const ownerFile = path.join(lockPath, "owner.json");
	const lockId = getAccountLockId(email);
	const ownerId = `${process.pid}:${Date.now()}:${crypto.randomUUID()}`;
	const startedAt = Date.now();
	let loggedWait = false;

	while (true) {
		try {
			const lockDir = getTokenRefreshLockDir();
			if (!fs.existsSync(lockDir)) {
				fs.mkdirSync(lockDir, { recursive: true });
			}
			fs.mkdirSync(lockPath);
			try {
				fs.writeFileSync(
					ownerFile,
					JSON.stringify(
						{ ownerId, pid: process.pid, lockId, email, createdAt: Date.now() },
						null,
						2,
					),
				);
			} catch (error) {
				fs.rmSync(lockPath, { recursive: true, force: true });
				throw error;
			}
			logMulticodex("token.refresh.lock.acquired", {
				email,
				lockId,
				waitMs: Date.now() - startedAt,
			});

			let released = false;
			return () => {
				if (released) return;
				released = true;
				try {
					const stored = JSON.parse(fs.readFileSync(ownerFile, "utf-8")) as {
						ownerId?: string;
					};
					if (stored.ownerId !== ownerId) {
						logMulticodex("token.refresh.lock.release.skipped", {
							email,
							lockId,
							reason: "owner_mismatch",
						});
						return;
					}
					fs.rmSync(lockPath, { recursive: true, force: true });
					logMulticodex("token.refresh.lock.released", { email, lockId });
				} catch (error) {
					if (!fs.existsSync(lockPath)) {
						logMulticodex("token.refresh.lock.release.missing", {
							email,
							lockId,
						});
						return;
					}
					logMulticodex("token.refresh.lock.release.failure", {
						email,
						lockId,
						error,
					});
				}
			};
		} catch (error) {
			if (getErrnoCode(error) !== "EEXIST") {
				logMulticodex("token.refresh.lock.acquire.failure", {
					email,
					lockId,
					error,
				});
				throw error;
			}

			let lockAgeMs = 0;
			try {
				lockAgeMs = Date.now() - fs.statSync(lockPath).mtimeMs;
			} catch {
				continue;
			}

			if (lockAgeMs > TOKEN_REFRESH_LOCK_STALE_MS) {
				logMulticodex("token.refresh.lock.stale_removed", {
					email,
					lockId,
					lockAgeMs,
				});
				fs.rmSync(lockPath, { recursive: true, force: true });
				continue;
			}

			const waitedMs = Date.now() - startedAt;
			if (waitedMs > TOKEN_REFRESH_LOCK_WAIT_MS) {
				const timeoutError = new Error(
					`Timed out waiting for token refresh lock for ${email}`,
				);
				logMulticodex("token.refresh.lock.timeout", {
					email,
					lockId,
					waitedMs,
				});
				throw timeoutError;
			}

			if (!loggedWait) {
				loggedWait = true;
				logMulticodex("token.refresh.lock.wait", { email, lockId });
			}
			await sleep(TOKEN_REFRESH_LOCK_POLL_MS);
		}
	}
}

export function isQuotaErrorMessage(message: string): boolean {
	return /\b429\b|quota|usage limit|rate.?limit|too many requests|limit reached/i.test(
		message,
	);
}

function getErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return typeof err === "string" ? err : JSON.stringify(err);
}

function createErrorAssistantMessage(
	model: Model<Api>,
	message: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
}

interface CodexUsageWindow {
	usedPercent?: number;
	resetAt?: number;
	limitWindowSeconds?: number;
}

export interface CodexUsageSnapshot {
	primary?: CodexUsageWindow;
	secondary?: CodexUsageWindow;
	fetchedAt: number;
}

interface WhamUsageResponse {
	rate_limit?: {
		primary_window?: WhamUsageWindow;
		secondary_window?: WhamUsageWindow;
	};
}

type WhamUsageWindow = {
	reset_at?: number;
	used_percent?: number;
	limit_window_seconds?: number;
};

export type ThinkingLevelMap = Partial<
	Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>
>;

export interface ProviderModelDef {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
}

function getThinkingLevelMap(model: Model<Api>): ThinkingLevelMap | undefined {
	return (model as Model<Api> & { thinkingLevelMap?: ThinkingLevelMap })
		.thinkingLevelMap;
}

export function getOpenAICodexMirror(): {
	baseUrl: string;
	models: ProviderModelDef[];
} {
	const sourceModels = getModels("openai-codex");
	return {
		baseUrl: sourceModels[0]?.baseUrl || "https://chatgpt.com/backend-api",
		models: sourceModels.map((m) => {
			const thinkingLevelMap = getThinkingLevelMap(m);
			return {
				id: m.id,
				name: m.name,
				reasoning: m.reasoning,
				...(thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),
				input: m.input,
				cost: m.cost,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
			};
		}),
	};
}

function normalizeUsedPercent(value?: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(100, Math.max(0, value));
}

function normalizeResetAt(value?: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return value * 1000;
}

function parseUsageWindow(
	window?: WhamUsageWindow,
): CodexUsageWindow | undefined {
	if (!window) return undefined;
	const usedPercent = normalizeUsedPercent(window.used_percent);
	const resetAt = normalizeResetAt(window.reset_at);
	const limitWindowSeconds =
		typeof window.limit_window_seconds === "number" &&
		Number.isFinite(window.limit_window_seconds)
			? window.limit_window_seconds
			: undefined;
	if (
		usedPercent === undefined &&
		resetAt === undefined &&
		limitWindowSeconds === undefined
	) {
		return undefined;
	}
	return { usedPercent, resetAt, limitWindowSeconds };
}

export function parseCodexUsageResponse(
	data: WhamUsageResponse,
): Omit<CodexUsageSnapshot, "fetchedAt"> {
	const rawPrimary = data.rate_limit?.primary_window;
	const rawSecondary = data.rate_limit?.secondary_window;
	let primary: CodexUsageWindow | undefined;
	let secondary: CodexUsageWindow | undefined;
	const unclassified: Array<{
		position: "primary" | "secondary";
		window: WhamUsageWindow;
	}> = [];

	for (const [position, window] of [
		["primary", rawPrimary],
		["secondary", rawSecondary],
	] as const) {
		if (!window) continue;
		const duration = window.limit_window_seconds;
		if (typeof duration !== "number" || !Number.isFinite(duration)) {
			unclassified.push({ position, window });
		} else if (duration <= 24 * 60 * 60) {
			primary = parseUsageWindow(window);
		} else {
			secondary = parseUsageWindow(window);
		}
	}

	// Older responses omitted limit_window_seconds and consistently used
	// primary_window for 5-hour usage and secondary_window for weekly usage.
	for (const entry of unclassified) {
		if (entry.position === "primary" && !primary) {
			primary = parseUsageWindow(entry.window);
		} else if (entry.position === "secondary" && !secondary) {
			secondary = parseUsageWindow(entry.window);
		}
	}

	return { primary, secondary };
}

export function isUsageUntouched(usage?: CodexUsageSnapshot): boolean {
	const primary = usage?.primary?.usedPercent;
	const secondary = usage?.secondary?.usedPercent;
	if (primary === undefined || secondary === undefined) return false;
	return primary === 0 && secondary === 0;
}

export function getNextResetAt(usage?: CodexUsageSnapshot): number | undefined {
	const candidates = [
		usage?.primary?.resetAt,
		usage?.secondary?.resetAt,
	].filter((value): value is number => typeof value === "number");
	if (candidates.length === 0) return undefined;
	return Math.min(...candidates);
}

// Weekly reset only (secondary window)
export function getWeeklyResetAt(
	usage?: CodexUsageSnapshot,
): number | undefined {
	const resetAt = usage?.secondary?.resetAt;
	return typeof resetAt === "number" ? resetAt : undefined;
}

function formatResetAt(resetAt?: number): string {
	if (!resetAt) return "unknown";
	const diffMs = resetAt - Date.now();
	if (diffMs <= 0) return "now";
	const diffMinutes = Math.max(1, Math.round(diffMs / 60000));
	if (diffMinutes < 60) return `in ${diffMinutes}m`;
	const diffHours = Math.round(diffMinutes / 60);
	if (diffHours < 48) return `in ${diffHours}h`;
	const diffDays = Math.round(diffHours / 24);
	return `in ${diffDays}d`;
}

async function fetchCodexUsage(
	accessToken: string,
	accountId: string | undefined,
	options?: { signal?: AbortSignal },
): Promise<CodexUsageSnapshot> {
	const { controller, clear } = createTimeoutController(
		options?.signal,
		USAGE_REQUEST_TIMEOUT_MS,
	);
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
		};
		if (accountId) {
			headers["ChatGPT-Account-Id"] = accountId;
		}

		const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
			headers,
			signal: controller.signal,
		});

		if (!response.ok) {
			throw new Error(`Usage request failed: ${response.status}`);
		}

		const data = (await response.json()) as WhamUsageResponse;
		return { ...parseCodexUsageResponse(data), fetchedAt: Date.now() };
	} finally {
		clear();
	}
}

function createLinkedAbortController(signal?: AbortSignal): AbortController {
	const controller = new AbortController();
	if (signal?.aborted) {
		controller.abort();
		return controller;
	}
	signal?.addEventListener("abort", () => controller.abort(), { once: true });
	return controller;
}

function createTimeoutController(
	signal: AbortSignal | undefined,
	timeoutMs: number,
): { controller: AbortController; clear: () => void } {
	const controller = createLinkedAbortController(signal);
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	return {
		controller,
		clear: () => clearTimeout(timeout),
	};
}

function withModelIdentity(
	event: AssistantMessageEvent,
	provider: string,
	api: Api,
): AssistantMessageEvent {
	if ("partial" in event) {
		return { ...event, partial: { ...event.partial, provider, api } };
	}
	if (event.type === "done") {
		return { ...event, message: { ...event.message, provider, api } };
	}
	if (event.type === "error") {
		return { ...event, error: { ...event.error, provider, api } };
	}
	return event;
}

async function openLoginInBrowser(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	url: string,
): Promise<void> {
	let command: string;
	let args: string[];

	if (process.platform === "darwin") {
		command = "open";
		args = [url];
	} else if (process.platform === "win32") {
		command = "cmd";
		args = ["/c", "start", "", url];
	} else {
		command = "xdg-open";
		args = [url];
	}

	try {
		await pi.exec(command, args);
	} catch (error) {
		ctx.ui.notify(
			"Could not open a browser automatically. Please open the login URL manually.",
			"warning",
		);
		console.warn("[multicodex] Failed to open browser:", error);
	}
}

// =============================================================================
// Storage
// =============================================================================

export interface Account {
	email: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	accountId?: string;
	lastUsed?: number;
}

interface StorageData {
	accounts: Account[];
	activeEmail?: string;
}

function normalizeStorageData(value: unknown): StorageData {
	const raw = (value ?? {}) as Partial<StorageData>;
	const accounts = Array.isArray(raw.accounts)
		? raw.accounts.map((value) => {
				const { quotaExhaustedUntil: _legacyQuotaFlag, ...account } =
					value as Account & { quotaExhaustedUntil?: unknown };
				return account;
			})
		: [];
	return {
		accounts,
		...(typeof raw.activeEmail === "string"
			? { activeEmail: raw.activeEmail }
			: {}),
	};
}

const STORAGE_FILE = path.join(os.homedir(), ".pi", "agent", "multicodex.json");
const PROVIDER_ID = "multicodex";
const BASE_CODEX_API = "openai-codex-responses" as const;
const MULTICODEX_API = "multicodex-codex-responses" as const;
type MulticodexApi = typeof MULTICODEX_API;
type WarningHandler = (message: string) => void;

/**
 * Quota is authoritative server state. Do not persist a local "exhausted"
 * marker: the 5-hour and weekly windows can reset independently.
 */
export function isUsageQuotaExhausted(
	usage?: CodexUsageSnapshot,
	now = Date.now(),
): boolean {
	return [usage?.primary, usage?.secondary].some((window) => {
		if (window?.usedPercent === undefined || window.usedPercent < 100) {
			return false;
		}
		// A reset in the past means the snapshot has expired. The caller will
		// refresh stale snapshots before automatic account selection.
		return window.resetAt === undefined || window.resetAt > now;
	});
}

function isAccountAvailable(
	account: Account,
	usageByEmail: Map<string, CodexUsageSnapshot>,
	now: number,
): boolean {
	return !isUsageQuotaExhausted(usageByEmail.get(account.email), now);
}

function pickRandomAccount(accounts: Account[]): Account | undefined {
	if (accounts.length === 0) return undefined;
	return accounts[Math.floor(Math.random() * accounts.length)];
}

function pickEarliestWeeklyResetAccount(
	accounts: Account[],
	usageByEmail: Map<string, CodexUsageSnapshot>,
): Account | undefined {
	const candidates = accounts
		.map((account) => ({
			account,
			resetAt: getWeeklyResetAt(usageByEmail.get(account.email)),
		}))
		.filter(
			(entry): entry is { account: Account; resetAt: number } =>
				typeof entry.resetAt === "number",
		)
		.sort((a, b) => a.resetAt - b.resetAt);

	return candidates[0]?.account;
}

export function pickBestAccount(
	accounts: Account[],
	usageByEmail: Map<string, CodexUsageSnapshot>,
	options?: { excludeEmails?: Set<string>; now?: number },
): Account | undefined {
	const now = options?.now ?? Date.now();
	const available = accounts.filter(
		(account) =>
			isAccountAvailable(account, usageByEmail, now) &&
			!options?.excludeEmails?.has(account.email),
	);
	if (available.length === 0) return undefined;

	const withUsage = available.filter((account) =>
		usageByEmail.has(account.email),
	);
	const untouched = withUsage.filter((account) =>
		isUsageUntouched(usageByEmail.get(account.email)),
	);

	if (untouched.length > 0) {
		return (
			pickEarliestWeeklyResetAccount(untouched, usageByEmail) ??
			pickRandomAccount(untouched)
		);
	}

	const earliestWeeklyReset = pickEarliestWeeklyResetAccount(
		withUsage,
		usageByEmail,
	);
	if (earliestWeeklyReset) return earliestWeeklyReset;

	return pickRandomAccount(available);
}

// =============================================================================
// Account Manager
// =============================================================================

export class AccountManager {
	private data: StorageData;
	private usageCache = new Map<string, CodexUsageSnapshot>();
	private tokenRefreshes = new Map<string, Promise<string>>();
	private warningHandler?: WarningHandler;
	private manualEmail?: string;

	constructor() {
		this.data = this.load();
	}

	private load(): StorageData {
		try {
			const storageFile = getMulticodexStorageFile();
			if (fs.existsSync(storageFile)) {
				const data = normalizeStorageData(
					JSON.parse(fs.readFileSync(storageFile, "utf-8")),
				);
				logMulticodex("storage.load.success", {
					accounts: data.accounts.length,
					activeEmail: data.activeEmail,
				});
				return data;
			}
			logMulticodex("storage.load.missing");
		} catch (e) {
			console.error("Failed to load multicodex accounts:", e);
			logMulticodex("storage.load.failure", { error: e });
		}
		return { accounts: [] };
	}

	private save(): void {
		try {
			const storageFile = getMulticodexStorageFile();
			const dir = path.dirname(storageFile);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				storageFile,
				JSON.stringify(normalizeStorageData(this.data), null, 2),
			);
			logMulticodex("storage.save.success", {
				accounts: this.data.accounts.map((account) => ({
					email: account.email,
					expiresAt: account.expiresAt,
				})),
				activeEmail: this.data.activeEmail,
			});
		} catch (e) {
			console.error("Failed to save multicodex accounts:", e);
			logMulticodex("storage.save.failure", { error: e });
		}
	}

	getAccounts(): Account[] {
		return this.data.accounts;
	}

	getAccount(email: string): Account | undefined {
		return this.data.accounts.find((a) => a.email === email);
	}

	setWarningHandler(handler?: WarningHandler): void {
		this.warningHandler = handler;
	}

	addOrUpdateAccount(email: string, creds: OAuthCredentials): void {
		const existing = this.getAccount(email);
		const accountId =
			typeof creds.accountId === "string" ? creds.accountId : undefined;
		logMulticodex("account.upsert.start", {
			email,
			existing: Boolean(existing),
			hasAccountId: Boolean(accountId),
			expiresAt: creds.expires,
		});
		if (existing) {
			existing.accessToken = creds.access;
			existing.refreshToken = creds.refresh;
			existing.expiresAt = creds.expires;
			if (accountId) {
				existing.accountId = accountId;
			}
		} else {
			this.data.accounts.push({
				email,
				accessToken: creds.access,
				refreshToken: creds.refresh,
				expiresAt: creds.expires,
				accountId,
			});
		}
		this.setActiveAccount(email);
		logMulticodex("account.upsert.success", { email });
	}

	getActiveAccount(): Account | undefined {
		const manual = this.getManualAccount();
		if (manual) return manual;
		if (this.data.activeEmail) {
			return this.getAccount(this.data.activeEmail);
		}
		return this.data.accounts[0];
	}

	getManualAccount(): Account | undefined {
		if (!this.manualEmail) return undefined;
		const account = this.getAccount(this.manualEmail);
		if (!account) {
			this.manualEmail = undefined;
			return undefined;
		}
		return account;
	}

	hasManualAccount(): boolean {
		return Boolean(this.getManualAccount());
	}

	getAvailableManualAccount(options?: {
		now?: number;
		excludeEmails?: Set<string>;
	}): Account | undefined {
		const now = options?.now ?? Date.now();
		const manual = this.getManualAccount();
		if (!manual) return undefined;
		if (options?.excludeEmails?.has(manual.email)) return undefined;
		if (!isAccountAvailable(manual, this.usageCache, now)) return undefined;
		return manual;
	}

	setActiveAccount(email: string): void {
		const account = this.getAccount(email);
		if (!account) {
			logMulticodex("account.active.missing", { email });
			return;
		}
		this.data.activeEmail = email;
		account.lastUsed = Date.now();
		this.save();
		// 		logMulticodex("account.active.set", { email });
	}

	setManualAccount(email: string): void {
		const account = this.getAccount(email);
		if (!account) {
			logMulticodex("account.manual.missing", { email });
			return;
		}
		this.manualEmail = email;
		account.lastUsed = Date.now();
		logMulticodex("account.manual.set", { email });
	}

	clearManualAccount(): void {
		if (this.manualEmail) {
			logMulticodex("account.manual.clear", { email: this.manualEmail });
		}
		this.manualEmail = undefined;
	}

	getCachedUsage(email: string): CodexUsageSnapshot | undefined {
		return this.usageCache.get(email);
	}

	async refreshUsageForAccount(
		account: Account,
		options?: { force?: boolean; signal?: AbortSignal },
	): Promise<CodexUsageSnapshot | undefined> {
		const cached = this.usageCache.get(account.email);
		const now = Date.now();
		if (
			cached &&
			!options?.force &&
			now - cached.fetchedAt < USAGE_CACHE_TTL_MS
		) {
			return cached;
		}

		try {
			// 			logMulticodex("usage.refresh.start", {
			// 				email: account.email,
			// 				force: Boolean(options?.force),
			// 			});
			const token = await this.ensureValidToken(account);
			const usage = await fetchCodexUsage(token, account.accountId, {
				signal: options?.signal,
			});
			this.usageCache.set(account.email, usage);
			writeUsageLedgerEvent({
				type: "quota_snapshot",
				timestamp: new Date(usage.fetchedAt).toISOString(),
				account: account.email,
				primary: usage.primary ?? null,
				secondary: usage.secondary ?? null,
			});
			// 			logMulticodex("usage.refresh.success", {
			// 				email: account.email,
			// 				primaryUsedPercent: usage.primary?.usedPercent,
			// 				secondaryUsedPercent: usage.secondary?.usedPercent,
			// 			});
			return usage;
		} catch (error) {
			logMulticodex("usage.refresh.failure", {
				email: account.email,
				error,
			});
			this.warningHandler?.(
				`Multicodex: failed to fetch usage for ${account.email}: ${getErrorMessage(
					error,
				)}`,
			);
			return undefined;
		}
	}

	async refreshUsageForAllAccounts(options?: {
		force?: boolean;
		signal?: AbortSignal;
	}): Promise<void> {
		const accounts = this.getAccounts();
		// 		logMulticodex("usage.refresh_all.start", {
		// 			accounts: accounts.length,
		// 			force: Boolean(options?.force),
		// 		});
		await Promise.all(
			accounts.map((account) => this.refreshUsageForAccount(account, options)),
		);
		// 		logMulticodex("usage.refresh_all.done", { accounts: accounts.length });
	}

	async refreshUsageIfStale(
		accounts: Account[],
		options?: { signal?: AbortSignal },
	): Promise<void> {
		const now = Date.now();
		const stale = accounts.filter((account) => {
			const cached = this.usageCache.get(account.email);
			return !cached || now - cached.fetchedAt >= USAGE_CACHE_TTL_MS;
		});
		if (stale.length === 0) return;
		await Promise.all(
			stale.map((account) =>
				this.refreshUsageForAccount(account, { force: true, ...options }),
			),
		);
	}

	async activateBestAccount(options?: {
		excludeEmails?: Set<string>;
		signal?: AbortSignal;
	}): Promise<Account | undefined> {
		const now = Date.now();
		const accounts = this.data.accounts;
		await this.refreshUsageIfStale(accounts, options);

		const selected = pickBestAccount(accounts, this.usageCache, {
			excludeEmails: options?.excludeEmails,
			now,
		});
		if (selected) {
			this.setActiveAccount(selected.email);
			// 			logMulticodex("account.best.selected", {
			// 				email: selected.email,
			// 				excludedEmails: options?.excludeEmails?.size ?? 0,
			// 			});
		} else {
			logMulticodex("account.best.none", {
				accounts: accounts.length,
				excludedEmails: options?.excludeEmails?.size ?? 0,
			});
		}
		return selected;
	}

	async handleQuotaExceeded(
		account: Account,
		options?: { signal?: AbortSignal },
	): Promise<void> {
		logMulticodex("quota.exceeded", { email: account.email });
		const usage = await this.refreshUsageForAccount(account, {
			force: true,
			signal: options?.signal,
		});
		// The forced refresh above updates the authoritative 5-hour/weekly
		// windows. Selection will use those values on the next attempt.
		if (usage && isUsageQuotaExhausted(usage, Date.now())) {
			logMulticodex("account.quota.server_exhausted", {
				email: account.email,
				primaryUsedPercent: usage.primary?.usedPercent,
				secondaryUsedPercent: usage.secondary?.usedPercent,
			});
		}
	}

	private isAccessTokenFresh(account: Account): boolean {
		return Date.now() < account.expiresAt - ACCESS_TOKEN_REFRESH_SKEW_MS;
	}

	private tryReloadFromDisk(): boolean {
		try {
			const storageFile = getMulticodexStorageFile();
			if (!fs.existsSync(storageFile)) return false;
			this.data = normalizeStorageData(
				JSON.parse(fs.readFileSync(storageFile, "utf-8")),
			);
			logMulticodex("storage.reload.success", {
				accounts: this.data.accounts.length,
				activeEmail: this.data.activeEmail,
			});
			return true;
		} catch (error) {
			logMulticodex("storage.reload.failure", { error });
			return false;
		}
	}

	private syncAccountFields(target: Account, source: Account): void {
		target.email = source.email;
		target.accessToken = source.accessToken;
		target.refreshToken = source.refreshToken;
		target.expiresAt = source.expiresAt;
		target.accountId = source.accountId;
		target.lastUsed = source.lastUsed;
	}

	private getOrAttachAccount(account: Account): Account {
		const current = this.getAccount(account.email);
		if (current) return current;
		this.data.accounts.push(account);
		logMulticodex("account.attach_missing", { email: account.email });
		return account;
	}

	private async refreshTokenWithLocks(account: Account): Promise<string> {
		const releaseLock = await acquireTokenRefreshLock(account.email);
		try {
			this.tryReloadFromDisk();
			const current = this.getOrAttachAccount(account);
			if (current !== account) {
				this.syncAccountFields(account, current);
			}

			if (this.isAccessTokenFresh(current)) {
				logMulticodex("token.refresh.skip_after_lock", {
					email: current.email,
					expiresAt: current.expiresAt,
				});
				return current.accessToken;
			}

			logMulticodex("token.refresh.start", {
				email: current.email,
				expiresAt: current.expiresAt,
			});
			const result = await refreshOpenAICodexToken(current.refreshToken);
			current.accessToken = result.access;
			current.refreshToken = result.refresh;
			current.expiresAt = result.expires;
			const accountId =
				typeof result.accountId === "string" ? result.accountId : undefined;
			if (accountId) {
				current.accountId = accountId;
			}
			this.save();
			if (current !== account) {
				this.syncAccountFields(account, current);
			}
			logMulticodex("token.refresh.success", {
				email: current.email,
				expiresAt: current.expiresAt,
				hasAccountId: Boolean(current.accountId),
			});
			return current.accessToken;
		} catch (error) {
			logMulticodex("token.refresh.failure", {
				email: account.email,
				error,
			});
			throw error;
		} finally {
			releaseLock();
		}
	}

	async ensureValidToken(account: Account): Promise<string> {
		// Valid for at least 5 more mins
		if (this.isAccessTokenFresh(account)) {
			return account.accessToken;
		}

		const inFlight = this.tokenRefreshes.get(account.email);
		if (inFlight) {
			logMulticodex("token.refresh.wait_in_process", {
				email: account.email,
			});
			return inFlight;
		}

		const refresh = this.refreshTokenWithLocks(account).finally(() => {
			this.tokenRefreshes.delete(account.email);
		});
		this.tokenRefreshes.set(account.email, refresh);
		return refresh;
	}
}

// =============================================================================
// Usage heatmap
// =============================================================================

interface HeatmapDay {
	date: Date;
	key: string;
	usage?: DailyUsage;
	future: boolean;
}

function addLocalDays(date: Date, days: number): Date {
	const result = new Date(date);
	result.setDate(result.getDate() + days);
	return result;
}

export function startOfLocalWeekMonday(date: Date): Date {
	const result = new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate(),
		12,
	);
	const mondayOffset = (result.getDay() + 6) % 7;
	result.setDate(result.getDate() - mondayOffset);
	return result;
}

function aggregateUsageDays(
	analysis: UsageLedgerAnalysis,
	account?: string,
): Map<string, DailyUsage> {
	if (account) return analysis.byAccount.get(account) ?? new Map();
	const result = new Map<string, DailyUsage>();
	for (const days of analysis.byAccount.values()) {
		for (const [key, usage] of days) {
			const current = result.get(key) ?? { requests: 0, tokens: 0 };
			current.requests += usage.requests;
			current.tokens += usage.tokens;
			result.set(key, current);
		}
	}
	return result;
}

export function buildHeatmapWeeks(
	days: Map<string, DailyUsage>,
	weekCount: number,
	now = new Date(),
): HeatmapDay[][] {
	const thisMonday = startOfLocalWeekMonday(now);
	const firstMonday = addLocalDays(thisMonday, -(weekCount - 1) * 7);
	const todayKey = localDateKey(now);
	return Array.from({ length: weekCount }, (_, week) =>
		Array.from({ length: 7 }, (_unused, weekday) => {
			const date = addLocalDays(firstMonday, week * 7 + weekday);
			const key = localDateKey(date);
			return { date, key, usage: days.get(key), future: key > todayKey };
		}),
	);
}

function formatInteger(value: number): string {
	return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
		value,
	);
}

function truncatePlain(value: string, width: number): string {
	if (width <= 0) return "";
	if (value.length <= width) return value;
	if (width === 1) return "…";
	return `${value.slice(0, width - 1)}…`;
}

const GITHUB_HEATMAP_COLORS = [
	"#6e7681",
	"#0e4429",
	"#006d32",
	"#26a641",
	"#39d353",
] as const;

function hexForeground(hex: string, text: string): string {
	const value = Number.parseInt(hex.slice(1), 16);
	const red = (value >> 16) & 0xff;
	const green = (value >> 8) & 0xff;
	const blue = value & 0xff;
	return `\u001b[38;2;${red};${green};${blue}m${text}\u001b[39m`;
}

export function getHeatmapLevel(value: number, max: number): number {
	if (value <= 0) return 0;
	if (max <= 1) return 4;
	return Math.max(
		1,
		Math.min(4, Math.ceil((Math.log1p(value) / Math.log1p(max)) * 4)),
	);
}

function heatmapSquare(level: number): string {
	return hexForeground(
		GITHUB_HEATMAP_COLORS[level] ?? GITHUB_HEATMAP_COLORS[0],
		"■",
	);
}

function createUsageHeatmapComponent(
	analysis: UsageLedgerAnalysis,
	accounts: string[],
	theme: {
		fg(color: string, text: string): string;
		bold(text: string): string;
	},
	onChange: () => void,
	onClose: () => void,
) {
	const views: Array<{ label: string; account?: string }> = [
		{ label: "All accounts" },
		...accounts.map((account, index) => ({
			label: `${index + 1}. ${account}`,
			account,
		})),
	];
	let selected = 0;

	return {
		render(width: number): string[] {
			const safeWidth = Math.max(1, width);
			const weekCount = Math.max(
				1,
				Math.min(53, Math.floor((safeWidth - 5) / 2)),
			);
			const view = views[selected] ?? views[0];
			const days = aggregateUsageDays(analysis, view?.account);
			const weeks = buildHeatmapWeeks(days, weekCount);
			const values = [...days.values()].map(
				(usage) => usage.tokens || usage.requests,
			);
			const max = Math.max(1, ...values);
			const shade = (day: HeatmapDay): string => {
				if (day.future) return " ";
				const value = day.usage?.tokens || day.usage?.requests || 0;
				return heatmapSquare(getHeatmapLevel(value, max));
			};
			const total = [...days.values()].reduce(
				(sum, usage) => ({
					requests: sum.requests + usage.requests,
					tokens: sum.tokens + usage.tokens,
				}),
				{ requests: 0, tokens: 0 },
			);
			const monthLine = Array.from({ length: weekCount }, (_, index) => {
				const current = weeks[index]?.[0]?.date;
				const previous = weeks[index - 1]?.[0]?.date;
				if (
					!current ||
					(previous && current.getMonth() === previous.getMonth())
				) {
					return "  ";
				}
				return `${current.toLocaleString("en-US", { month: "short" }).slice(0, 1)} `;
			}).join("");
			const weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
			const summary = `${formatInteger(total.requests)} requests · ${formatInteger(total.tokens)} tokens`;
			const legendPlain = "Daily tokens  Less ■ ■ ■ ■ ■ More";
			const legend = `Daily tokens  Less ${GITHUB_HEATMAP_COLORS.map((_color, level) => heatmapSquare(level)).join(" ")} More`;
			const summaryAndLegend =
				summary.length + legendPlain.length + 2 <= safeWidth
					? `${summary}${" ".repeat(safeWidth - summary.length - legendPlain.length)}${legend}`
					: truncatePlain(summary, safeWidth);
			const lines = [
				theme.fg(
					"accent",
					theme.bold(truncatePlain("MultiCodex usage", safeWidth)),
				),
				theme.fg(
					"text",
					truncatePlain(view?.label ?? "All accounts", safeWidth),
				),
				`    ${monthLine}`,
				...weekdayLabels.map(
					(label, weekday) =>
						`${label} ${weeks.map((week) => `${shade(week[weekday] as HeatmapDay)} `).join("")}`,
				),
				summaryAndLegend,
			];
			if (summary.length + legendPlain.length + 2 > safeWidth) {
				lines.push(
					legendPlain.length <= safeWidth
						? `${" ".repeat(safeWidth - legendPlain.length)}${legend}`
						: truncateToWidth(legend, safeWidth),
				);
			}
			lines.push(
				theme.fg(
					"dim",
					truncatePlain(
						"Each square is one day · ←/→ account · Monday-first · esc/enter close",
						safeWidth,
					),
				),
			);
			return lines;
		},
		handleInput(data: string): void {
			if (matchesKey(data, Key.left) || data === "h") {
				selected = (selected - 1 + views.length) % views.length;
				onChange();
			} else if (matchesKey(data, Key.right) || data === "l") {
				selected = (selected + 1) % views.length;
				onChange();
			} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
				onClose();
			}
		},
		invalidate(): void {},
	};
}

// =============================================================================
// Extension Entry Point
// =============================================================================

type ApiProviderRef = NonNullable<ReturnType<typeof getApiProvider>>;

export function buildMulticodexProviderConfig(accountManager: AccountManager): {
	baseUrl: string;
	apiKey: string;
	api: MulticodexApi;
	streamSimple: (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
	models: ProviderModelDef[];
} {
	const mirror = getOpenAICodexMirror();
	const baseProvider = getApiProvider(BASE_CODEX_API);
	if (!baseProvider) {
		throw new Error(
			"OpenAI Codex provider not available. Please update pi to include openai-codex support.",
		);
	}
	return {
		baseUrl: mirror.baseUrl,
		apiKey: "managed-by-extension",
		api: MULTICODEX_API,
		streamSimple: createStreamWrapper(accountManager, baseProvider),
		models: mirror.models,
	};
}

export default function multicodexExtension(pi: ExtensionAPI) {
	const accountManager = new AccountManager();
	let lastContext: ExtensionContext | undefined;

	accountManager.setWarningHandler((message) => {
		if (lastContext) {
			lastContext.ui.notify(message, "warning");
		}
	});

	pi.registerProvider(
		PROVIDER_ID,
		buildMulticodexProviderConfig(accountManager),
	);

	// Login command
	pi.registerCommand("multicodex-login", {
		description: "Login to an OpenAI Codex account for the rotation pool",
		handler: async (
			args: string,
			ctx: ExtensionCommandContext,
		): Promise<void> => {
			const email = args.trim();
			if (!email) {
				ctx.ui.notify(
					"Please provide an email/identifier: /multicodex-login my@email.com",
					"error",
				);
				return;
			}

			try {
				ctx.ui.notify(
					`Starting login for ${email}... Check your browser.`,
					"info",
				);

				const creds = await loginOpenAICodex({
					onAuth: ({ url }) => {
						void openLoginInBrowser(pi, ctx, url);
						ctx.ui.notify(`Please open this URL to login: ${url}`, "info");
						console.log(`[multicodex] Login URL: ${url}`);
					},
					onPrompt: async ({ message }) => (await ctx.ui.input(message)) || "",
				});

				accountManager.addOrUpdateAccount(email, creds);
				ctx.ui.notify(`Successfully logged in as ${email}`, "info");
			} catch (e) {
				ctx.ui.notify(`Login failed: ${getErrorMessage(e)}`, "error");
			}
		},
	});

	// View account status and select the active account.
	pi.registerCommand("multicodex-use", {
		description: "View Codex account usage and select an account",
		handler: async (
			_args: string,
			ctx: ExtensionCommandContext,
		): Promise<void> => {
			const accounts = accountManager.getAccounts();
			if (accounts.length === 0) {
				ctx.ui.notify(
					"No accounts logged in. Use /multicodex-login first.",
					"warning",
				);
				return;
			}

			await accountManager.refreshUsageForAllAccounts();
			const active = accountManager.getActiveAccount();
			const options = accounts.map((account) => {
				const usage = accountManager.getCachedUsage(account.email);
				const isActive = active?.email === account.email;
				const quotaHit = isUsageQuotaExhausted(usage, Date.now());
				const untouched = isUsageUntouched(usage) ? "untouched" : null;
				const tags = [
					isActive ? "active" : null,
					quotaHit ? "quota" : null,
					untouched,
				]
					.filter(Boolean)
					.join(", ");
				const suffix = tags ? ` (${tags})` : "";
				const primaryUsed = usage?.primary?.usedPercent;
				const secondaryUsed = usage?.secondary?.usedPercent;
				const primaryReset = usage?.primary?.resetAt;
				const secondaryReset = usage?.secondary?.resetAt;
				const primaryLabel =
					primaryUsed === undefined ? "unknown" : `${Math.round(primaryUsed)}%`;
				const secondaryLabel =
					secondaryUsed === undefined
						? "unknown"
						: `${Math.round(secondaryUsed)}%`;
				const usageSummary = `5h ${primaryLabel} reset:${formatResetAt(primaryReset)} | weekly ${secondaryLabel} reset:${formatResetAt(secondaryReset)}`;
				return `${isActive ? "•" : " "} ${account.email}${suffix} - ${usageSummary}`;
			});

			const selected = await ctx.ui.select(
				"Select MultiCodex Account",
				options,
			);
			if (!selected) return;
			const selectedIndex = options.indexOf(selected);
			const selectedAccount = accounts[selectedIndex];
			if (!selectedAccount) return;

			accountManager.setManualAccount(selectedAccount.email);
			ctx.ui.notify(`Switched to ${selectedAccount.email}`, "info");
		},
	});

	pi.registerCommand("multicodex-analyze", {
		description: "Analyze per-account usage in a Monday-first heatmap",
		handler: async (
			_args: string,
			ctx: ExtensionCommandContext,
		): Promise<void> => {
			const analysis = readUsageLedgerAnalysis();
			const accounts = [
				...new Set([
					...accountManager.getAccounts().map((account) => account.email),
					...analysis.accounts,
				]),
			];
			if (analysis.byAccount.size === 0) {
				ctx.ui.notify(
					"No request history yet. MultiCodex records usage after Codex requests complete.",
					"warning",
				);
				return;
			}
			if (ctx.mode && ctx.mode !== "tui") {
				ctx.ui.notify(
					`Usage history: ${analysis.accounts.length} account(s). Run /multicodex-analyze in interactive mode for the heatmap.`,
					"info",
				);
				return;
			}
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
				createUsageHeatmapComponent(
					analysis,
					accounts,
					theme,
					() => tui.requestRender(),
					() => done(undefined),
				),
			);
		},
	});

	// Hooks
	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		lastContext = ctx;
		if (accountManager.getAccounts().length === 0) return;
		void (async () => {
			await accountManager.refreshUsageForAllAccounts({ force: true });
			const manual = accountManager.getAvailableManualAccount();
			if (manual) return;
			if (accountManager.hasManualAccount()) {
				accountManager.clearManualAccount();
			}
			await accountManager.activateBestAccount();
		})();
	});

	pi.on(
		"session_switch",
		(event: { reason?: string }, ctx: ExtensionContext) => {
			lastContext = ctx;
			if (event.reason === "new") {
				void (async () => {
					await accountManager.refreshUsageForAllAccounts({ force: true });
					const manual = accountManager.getAvailableManualAccount();
					if (manual) return;
					if (accountManager.hasManualAccount()) {
						accountManager.clearManualAccount();
					}
					await accountManager.activateBestAccount();
				})();
			}
		},
	);
}

// =============================================================================
// Stream Wrapper
// =============================================================================

const MAX_ROTATION_RETRIES = 5;

export function createStreamWrapper(
	accountManager: AccountManager,
	baseProvider: ApiProviderRef,
) {
	return (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		const requestId = crypto.randomUUID();
		// 		logMulticodex("stream.start", {
		// 			requestId,
		// 			model: model.id,
		// 			provider: model.provider,
		// 		});

		(async () => {
			try {
				const excludedEmails = new Set<string>();
				for (let attempt = 0; attempt <= MAX_ROTATION_RETRIES; attempt++) {
					const now = Date.now();
					const manual = accountManager.getAvailableManualAccount({
						excludeEmails: excludedEmails,
						now,
					});
					const usingManual = Boolean(manual);
					let account = manual;
					if (!account) {
						if (accountManager.hasManualAccount()) {
							accountManager.clearManualAccount();
						}
						account = await accountManager.activateBestAccount({
							excludeEmails: excludedEmails,
							signal: options?.signal,
						});
					}
					if (!account) {
						throw new Error(
							"No available Multicodex accounts. Please use /multicodex-login.",
						);
					}

					// 					logMulticodex("stream.account.selected", {
					// 						requestId,
					// 						email: account.email,
					// 						attempt,
					// 						manual: usingManual,
					// 					});
					const token = await accountManager.ensureValidToken(account);

					const abortController = createLinkedAbortController(options?.signal);

					const internalModel: Model<typeof BASE_CODEX_API> = {
						...(model as Model<typeof BASE_CODEX_API>),
						provider: "openai-codex",
						api: BASE_CODEX_API,
					};

					const inner = baseProvider.streamSimple(
						{
							...internalModel,
							headers: {
								...(internalModel.headers || {}),
								"X-Multicodex-Account": account.email,
							},
						},
						context,
						{
							...options,
							apiKey: token,
							signal: abortController.signal,
						},
					);

					const attemptStartedAt = Date.now();
					let forwardedAny = false;
					let retry = false;

					for await (const event of inner) {
						if (event.type === "error") {
							const msg = event.error.errorMessage || "";
							const isQuota = isQuotaErrorMessage(msg);
							writeUsageLedgerEvent({
								type: "request",
								timestamp: new Date().toISOString(),
								requestId,
								attempt,
								account: account.email,
								model: model.id,
								reasoning: options?.reasoning ?? null,
								status: "error",
								stopReason: event.error.stopReason,
								quotaError: isQuota,
								durationMs: Date.now() - attemptStartedAt,
								usage: event.error.usage,
							});

							if (isQuota && !forwardedAny && attempt < MAX_ROTATION_RETRIES) {
								logMulticodex("stream.quota.retry", {
									requestId,
									email: account.email,
									attempt,
								});
								await accountManager.handleQuotaExceeded(account, {
									signal: options?.signal,
								});
								if (usingManual) {
									accountManager.clearManualAccount();
								}
								excludedEmails.add(account.email);
								abortController.abort();
								retry = true;
								break;
							}

							logMulticodex("stream.error", {
								requestId,
								email: account.email,
								attempt,
								isQuota,
								message: msg,
							});
							stream.push(withModelIdentity(event, model.provider, model.api));
							stream.end();
							return;
						}

						forwardedAny = true;
						stream.push(withModelIdentity(event, model.provider, model.api));

						if (event.type === "done") {
							writeUsageLedgerEvent({
								type: "request",
								timestamp: new Date().toISOString(),
								requestId,
								attempt,
								account: account.email,
								model: model.id,
								reasoning: options?.reasoning ?? null,
								status: "done",
								stopReason: event.message.stopReason,
								quotaError: false,
								durationMs: Date.now() - attemptStartedAt,
								usage: event.message.usage,
							});
							// Refresh asynchronously and at most once per cache TTL in normal
							// sequential use, so quota snapshots track ongoing consumption
							// without delaying the completed model response.
							void accountManager.refreshUsageForAccount(account);
							// 							logMulticodex("stream.done", {
							// 								requestId,
							// 								email: account.email,
							// 								attempt,
							// 							});
							stream.end();
							return;
						}
					}

					if (retry) {
						continue;
					}

					// If inner finished without done/error, stop to avoid hanging.
					logMulticodex("stream.inner_finished_without_terminal_event", {
						requestId,
						email: account.email,
						attempt,
					});
					stream.end();
					return;
				}
			} catch (e) {
				const message = getErrorMessage(e);
				logMulticodex("stream.failure", { requestId, error: e });
				const errorEvent: AssistantMessageEvent = {
					type: "error",
					reason: "error",
					error: createErrorAssistantMessage(
						model,
						`Multicodex failed: ${message}`,
					),
				};
				stream.push(withModelIdentity(errorEvent, model.provider, model.api));
				stream.end();
			}
		})();

		return stream;
	};
}
