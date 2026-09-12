import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getModels } from "@mariozechner/pi-ai";
import { refreshOpenAICodexToken } from "@mariozechner/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai/oauth", () => ({
	loginOpenAICodex: vi.fn(),
	refreshOpenAICodexToken: vi.fn(),
}));

import {
	type Account,
	AccountManager,
	buildHeatmapWeeks,
	buildMulticodexProviderConfig,
	createStreamWrapper,
	formatCodexUsageSummary,
	getHeatmapLevel,
	getNextResetAt,
	getOpenAICodexMirror,
	getWeeklyResetAt,
	isQuotaErrorMessage,
	isUsageQuotaExhausted,
	isUsageUntouched,
	parseCodexUsageResponse,
	parseResetCreditsResponse,
	pickBestAccount,
	readUsageLedgerAnalysis,
	startOfLocalWeekMonday,
	type ThinkingLevelMap,
	writeUsageLedgerEvent,
} from "./index";
import { refreshOpenAICodexTokenFallback } from "./openai-codex-oauth";

describe("usage ledger", () => {
	let tempDir: string;
	let previousUsageLogFile: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multicodex-ledger-test-"));
		previousUsageLogFile = process.env.MULTICODEX_USAGE_LOG_FILE;
		process.env.MULTICODEX_USAGE_LOG_FILE = path.join(tempDir, "usage.jsonl");
	});

	afterEach(() => {
		if (previousUsageLogFile === undefined) {
			delete process.env.MULTICODEX_USAGE_LOG_FILE;
		} else {
			process.env.MULTICODEX_USAGE_LOG_FILE = previousUsageLogFile;
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("appends versioned JSONL records", () => {
		writeUsageLedgerEvent({
			type: "request",
			timestamp: "2026-08-07T12:00:00.000Z",
			account: "a@example.com",
			usage: { input: 10, output: 2 },
		});
		writeUsageLedgerEvent({
			type: "quota_snapshot",
			timestamp: "2026-08-07T12:01:00.000Z",
			account: "a@example.com",
			primary: null,
			secondary: { usedPercent: 25, limitWindowSeconds: 604800 },
		});

		const records = fs
			.readFileSync(process.env.MULTICODEX_USAGE_LOG_FILE || "", "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({ version: 1, type: "request" });
		expect(records[1]).toMatchObject({
			version: 1,
			type: "quota_snapshot",
		});
	});
});

describe("usage heatmap levels", () => {
	it("uses grey for no usage and four green intensity levels", () => {
		expect(getHeatmapLevel(0, 100)).toBe(0);
		expect(getHeatmapLevel(1, 100)).toBe(1);
		expect(getHeatmapLevel(10, 100)).toBe(3);
		expect(getHeatmapLevel(100, 100)).toBe(4);
	});
});

describe("usage analysis", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "multicodex-analysis-test-"),
		);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("aggregates requests and tokens by account and local day", () => {
		const logFile = path.join(tempDir, "usage.jsonl");
		fs.writeFileSync(
			logFile,
			[
				JSON.stringify({
					type: "request",
					timestamp: "2026-08-03T12:00:00.000Z",
					account: "a@example.com",
					usage: { totalTokens: 12 },
				}),
				JSON.stringify({
					type: "request",
					timestamp: "2026-08-03T13:00:00.000Z",
					account: "a@example.com",
					usage: { input: 5, output: 2 },
				}),
				"not-json",
			].join("\n"),
		);

		const analysis = readUsageLedgerAnalysis(logFile);
		expect(analysis.accounts).toEqual(["a@example.com"]);
		const day = analysis.byAccount.get("a@example.com")?.get("2026-08-03");
		expect(day).toEqual({ requests: 2, tokens: 19 });
	});

	it("lays out each week from Monday through Sunday", () => {
		const now = new Date(2026, 7, 5, 12); // Wednesday
		expect(startOfLocalWeekMonday(now).getDay()).toBe(1);
		const weeks = buildHeatmapWeeks(new Map(), 2, now);
		expect(weeks[0]?.[0]?.date.getDay()).toBe(1);
		expect(weeks[0]?.[6]?.date.getDay()).toBe(0);
		expect(weeks[1]?.[0]?.date.getDate()).toBe(3);
	});

	it("does not hide the current day before noon", () => {
		const now = new Date(2026, 7, 7, 8);
		const weeks = buildHeatmapWeeks(new Map(), 1, now);
		expect(weeks[0]?.[4]?.future).toBe(false);
		expect(weeks[0]?.[5]?.future).toBe(true);
	});
});

describe("isQuotaErrorMessage", () => {
	it("matches 429", () => {
		expect(isQuotaErrorMessage("HTTP 429 Too Many Requests")).toBe(true);
	});

	it("matches common quota / usage limit messages", () => {
		expect(isQuotaErrorMessage("You have hit your ChatGPT usage limit.")).toBe(
			true,
		);
		expect(isQuotaErrorMessage("Quota exceeded")).toBe(true);
	});

	it("matches rate limit phrasing", () => {
		expect(isQuotaErrorMessage("rate limit exceeded")).toBe(true);
		expect(isQuotaErrorMessage("Rate-Limit: exceeded")).toBe(true);
	});

	it("does not match unrelated errors", () => {
		expect(isQuotaErrorMessage("network error")).toBe(false);
		expect(isQuotaErrorMessage("bad request")).toBe(false);
	});
});

describe("getOpenAICodexMirror", () => {
	it("mirrors the openai-codex provider models exactly (metadata)", () => {
		const sourceModels = getModels("openai-codex");
		const expected = {
			baseUrl: sourceModels[0]?.baseUrl || "https://chatgpt.com/backend-api",
			models: sourceModels.map((m) => {
				const thinkingLevelMap = (
					m as typeof m & { thinkingLevelMap?: ThinkingLevelMap }
				).thinkingLevelMap;
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

		expect(getOpenAICodexMirror()).toEqual(expected);
	});
});

describe("buildMulticodexProviderConfig", () => {
	it("uses mirrored models and baseUrl", () => {
		const mirror = getOpenAICodexMirror();
		const config = buildMulticodexProviderConfig(
			{} as unknown as AccountManager,
		);

		expect(config.api).toBe("multicodex-codex-responses");
		expect(config.apiKey).toBe("managed-by-extension");
		expect(config.baseUrl).toBe(mirror.baseUrl);
		expect(config.models).toEqual(mirror.models);
		expect(typeof config.streamSimple).toBe("function");
	});
});

describe("OpenAI Codex OAuth compatibility", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("refreshes directly when the pi OAuth entry point has no runtime helpers", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_000);
		const payload = Buffer.from(
			JSON.stringify({
				"https://api.openai.com/auth": {
					chatgpt_account_id: "acct-new",
				},
			}),
		).toString("base64url");
		const accessToken = `header.${payload}.signature`;
		const fetchMock = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						access_token: accessToken,
						refresh_token: "rotated-refresh",
						expires_in: 3600,
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			refreshOpenAICodexTokenFallback("old-refresh"),
		).resolves.toEqual({
			access: accessToken,
			refresh: "rotated-refresh",
			expires: 3_601_000,
			accountId: "acct-new",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] || [];
		expect(url).toBe("https://auth.openai.com/oauth/token");
		expect(init?.method).toBe("POST");
		const body = init?.body as URLSearchParams;
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("refresh_token")).toBe("old-refresh");
		expect(body.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
	});
});

function makeAccount(email: string, overrides?: Partial<Account>): Account {
	return {
		email,
		accessToken: "token",
		refreshToken: "refresh",
		expiresAt: 0,
		...overrides,
	};
}

type StreamWrapper = ReturnType<typeof createStreamWrapper>;
type StreamModel = Parameters<StreamWrapper>[0];
type StreamContext = Parameters<StreamWrapper>[1];
type BaseProvider = Parameters<typeof createStreamWrapper>[1];
type RefreshTokenResult = Awaited<ReturnType<typeof refreshOpenAICodexToken>>;
const refreshTokenMock = vi.mocked(refreshOpenAICodexToken);

describe("AccountManager token refresh", () => {
	let tempDir: string;
	let previousStorageFile: string | undefined;
	let previousLogFile: string | undefined;
	let previousLockDir: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multicodex-test-"));
		previousStorageFile = process.env.MULTICODEX_STORAGE_FILE;
		previousLogFile = process.env.MULTICODEX_LOG_FILE;
		previousLockDir = process.env.MULTICODEX_LOCK_DIR;
		process.env.MULTICODEX_STORAGE_FILE = path.join(tempDir, "accounts.json");
		process.env.MULTICODEX_LOG_FILE = path.join(tempDir, "multicodex.log");
		process.env.MULTICODEX_LOCK_DIR = path.join(tempDir, "locks");
		refreshTokenMock.mockReset();
	});

	function restoreEnv(name: string, value: string | undefined): void {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}

	afterEach(() => {
		restoreEnv("MULTICODEX_STORAGE_FILE", previousStorageFile);
		restoreEnv("MULTICODEX_LOG_FILE", previousLogFile);
		restoreEnv("MULTICODEX_LOCK_DIR", previousLockDir);
		vi.unstubAllGlobals();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("deduplicates concurrent refreshes for the same account", async () => {
		const manager = new AccountManager();
		manager.addOrUpdateAccount("a@example.com", {
			access: "old-access",
			refresh: "old-refresh",
			expires: 0,
			accountId: "acct-old",
		});
		const account = manager.getAccount("a@example.com");
		expect(account).toBeDefined();

		let resolveRefresh: (value: RefreshTokenResult) => void = () => {};
		let markStarted: () => void = () => {};
		const refreshResult = new Promise<RefreshTokenResult>((resolve) => {
			resolveRefresh = resolve;
		});
		const refreshStarted = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		refreshTokenMock.mockImplementation(async () => {
			markStarted();
			return refreshResult;
		});

		const first = manager.ensureValidToken(account as Account);
		await refreshStarted;
		const second = manager.ensureValidToken(account as Account);

		const expires = Date.now() + 60 * 60 * 1000;
		resolveRefresh({
			access: "new-access",
			refresh: "new-refresh",
			expires,
			accountId: "acct-new",
		});

		await expect(Promise.all([first, second])).resolves.toEqual([
			"new-access",
			"new-access",
		]);
		expect(refreshTokenMock).toHaveBeenCalledTimes(1);
		expect(refreshTokenMock).toHaveBeenCalledWith("old-refresh");
		expect(account?.refreshToken).toBe("new-refresh");

		const stored = JSON.parse(
			fs.readFileSync(process.env.MULTICODEX_STORAGE_FILE || "", "utf-8"),
		) as { accounts: Account[] };
		expect(stored.accounts[0]?.refreshToken).toBe("new-refresh");
		expect(stored.accounts[0]?.expiresAt).toBe(expires);
	});

	it("waits for a cross-manager refresh and reuses the saved rotated token", async () => {
		const managerA = new AccountManager();
		managerA.addOrUpdateAccount("a@example.com", {
			access: "old-access",
			refresh: "old-refresh",
			expires: 0,
			accountId: "acct-old",
		});
		const managerB = new AccountManager();
		const accountA = managerA.getAccount("a@example.com");
		const accountB = managerB.getAccount("a@example.com");
		expect(accountA).toBeDefined();
		expect(accountB).toBeDefined();

		let resolveRefresh: (value: RefreshTokenResult) => void = () => {};
		let markStarted: () => void = () => {};
		const refreshResult = new Promise<RefreshTokenResult>((resolve) => {
			resolveRefresh = resolve;
		});
		const refreshStarted = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		refreshTokenMock.mockImplementation(async () => {
			markStarted();
			return refreshResult;
		});

		const first = managerA.ensureValidToken(accountA as Account);
		await refreshStarted;
		const second = managerB.ensureValidToken(accountB as Account);

		resolveRefresh({
			access: "new-access",
			refresh: "new-refresh",
			expires: Date.now() + 60 * 60 * 1000,
			accountId: "acct-new",
		});

		await expect(Promise.all([first, second])).resolves.toEqual([
			"new-access",
			"new-access",
		]);
		expect(refreshTokenMock).toHaveBeenCalledTimes(1);
		expect(accountB?.refreshToken).toBe("new-refresh");
	});

	it("lists and consumes reset credits through the Codex backend", async () => {
		const manager = new AccountManager();
		manager.addOrUpdateAccount("a@example.com", {
			access: "access",
			refresh: "refresh",
			expires: Date.now() + 60 * 60 * 1000,
			accountId: "acct-a",
		});
		const account = manager.getAccount("a@example.com") as Account;
		const fetchMock = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/rate-limit-reset-credits/consume")) {
					return Response.json({ code: "reset", windows_reset: 2 });
				}
				if (url.endsWith("/rate-limit-reset-credits")) {
					return Response.json({
						available_count: 1,
						credits: [{ id: "credit-a", status: "available" }],
					});
				}
				if (url.endsWith("/usage")) {
					return Response.json({
						rate_limit: {
							primary_window: { used_percent: 0 },
							secondary_window: { used_percent: 0 },
						},
					});
				}
				throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(manager.getResetCredits(account)).resolves.toMatchObject([
			{ id: "credit-a", status: "available" },
		]);
		await expect(
			manager.redeemResetCredit(account, "credit-a", {
				idempotencyKey: "request-a",
			}),
		).resolves.toEqual({ code: "reset", windows_reset: 2 });

		const consumeCall = fetchMock.mock.calls.find(([input]) =>
			String(input).endsWith("/consume"),
		);
		expect(consumeCall?.[1]?.method).toBe("POST");
		expect(consumeCall?.[1]?.headers).toMatchObject({
			Authorization: "Bearer access",
			"ChatGPT-Account-Id": "acct-a",
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(consumeCall?.[1]?.body))).toEqual({
			redeem_request_id: "request-a",
			credit_id: "credit-a",
		});
		expect(
			fetchMock.mock.calls.some(([input]) => String(input).endsWith("/usage")),
		).toBe(true);
	});
});

describe("usage helpers", () => {
	it("parses usage response windows", () => {
		const response = parseCodexUsageResponse({
			rate_limit: {
				primary_window: {
					reset_at: 1700000000,
					used_percent: 12.5,
				},
				secondary_window: {
					reset_at: 1700003600,
					used_percent: 0,
				},
			},
		});

		expect(response.primary?.usedPercent).toBe(12.5);
		expect(response.primary?.resetAt).toBe(1700000000 * 1000);
		expect(response.secondary?.usedPercent).toBe(0);
		expect(response.secondary?.resetAt).toBe(1700003600 * 1000);
	});

	it("parses reset availability from the usage response", () => {
		const response = parseCodexUsageResponse({
			rate_limit_reset_credits: {
				available_count: 2,
				applicable_available_count: 1,
			},
		});

		expect(response.availableResetCount).toBe(2);
		expect(response.applicableResetCount).toBe(1);
	});

	it("classifies windows by duration when weekly usage moves to primary", () => {
		const response = parseCodexUsageResponse({
			rate_limit: {
				primary_window: {
					limit_window_seconds: 7 * 24 * 60 * 60,
					reset_at: 1700000000,
					used_percent: 100,
				},
				secondary_window: undefined,
			},
		});

		expect(response.primary).toBeUndefined();
		expect(response.secondary?.usedPercent).toBe(100);
		expect(response.secondary?.resetAt).toBe(1700000000 * 1000);
		expect(response.secondary?.limitWindowSeconds).toBe(7 * 24 * 60 * 60);
	});

	it("classifies a short primary and weekly secondary by duration", () => {
		const response = parseCodexUsageResponse({
			rate_limit: {
				primary_window: {
					limit_window_seconds: 5 * 60 * 60,
					used_percent: 12,
				},
				secondary_window: {
					limit_window_seconds: 7 * 24 * 60 * 60,
					used_percent: 34,
				},
			},
		});

		expect(response.primary?.usedPercent).toBe(12);
		expect(response.secondary?.usedPercent).toBe(34);
	});

	it("formats limits as remaining rather than used", () => {
		const summary = formatCodexUsageSummary({
			primary: { usedPercent: 1 },
			secondary: { usedPercent: 0 },
			fetchedAt: 0,
		});

		expect(summary).toContain("5h 99% left");
		expect(summary).toContain("weekly 100% left");
	});

	it("parses, filters, and orders reset credits", () => {
		const credits = parseResetCreditsResponse({
			credits: [
				{
					id: "later",
					status: "available",
					is_supported_by_plan: true,
					expires_at: "2026-10-04T22:53:53Z",
					title: "Full reset",
				},
				{
					id: "used",
					status: "redeemed",
				},
				{
					id: "earlier",
					status: "available",
					is_supported_by_plan: true,
					expires_at: "2026-10-01T01:00:00Z",
				},
				{
					id: "unsupported",
					status: "available",
					is_supported_by_plan: false,
				},
			],
		});

		expect(credits.map((credit) => credit.id)).toEqual(["earlier", "later"]);
	});

	it("detects untouched usage", () => {
		expect(
			isUsageUntouched({
				primary: { usedPercent: 0, resetAt: 1 },
				secondary: { usedPercent: 0, resetAt: 2 },
				fetchedAt: 0,
			}),
		).toBe(true);
		expect(
			isUsageUntouched({
				primary: { usedPercent: 0, resetAt: 1 },
				secondary: { usedPercent: 5, resetAt: 2 },
				fetchedAt: 0,
			}),
		).toBe(false);
	});

	it("picks earliest reset from usage", () => {
		expect(
			getNextResetAt({
				primary: { resetAt: 2000 },
				secondary: { resetAt: 1000 },
				fetchedAt: 0,
			}),
		).toBe(1000);
	});

	it("picks weekly reset from usage", () => {
		expect(
			getWeeklyResetAt({
				primary: { resetAt: 2000 },
				secondary: { resetAt: 1000 },
				fetchedAt: 0,
			}),
		).toBe(1000);
	});
});

describe("quota state", () => {
	it("derives exhaustion from the active 5-hour or weekly window", () => {
		const now = 10_000;
		expect(
			isUsageQuotaExhausted(
				{
					primary: { usedPercent: 100, resetAt: now + 1_000 },
					secondary: { usedPercent: 20, resetAt: now + 2_000 },
					fetchedAt: now,
				},
				now,
			),
		).toBe(true);
		expect(
			isUsageQuotaExhausted(
				{
					primary: { usedPercent: 100, resetAt: now - 1_000 },
					secondary: { usedPercent: 20, resetAt: now + 2_000 },
					fetchedAt: now,
				},
				now,
			),
		).toBe(false);
		expect(
			isUsageQuotaExhausted(
				{
					primary: { usedPercent: 20 },
					secondary: { usedPercent: 100, resetAt: now + 2_000 },
					fetchedAt: now,
				},
				now,
			),
		).toBe(true);
	});
});

describe("pickBestAccount", () => {
	it("prefers untouched accounts when available", () => {
		const accounts = [makeAccount("a"), makeAccount("b")];
		const usage = new Map([
			[
				"a",
				{
					primary: { usedPercent: 10, resetAt: 5000 },
					secondary: { usedPercent: 10, resetAt: 6000 },
					fetchedAt: 0,
				},
			],
			[
				"b",
				{
					primary: { usedPercent: 0, resetAt: 4000 },
					secondary: { usedPercent: 0, resetAt: 7000 },
					fetchedAt: 0,
				},
			],
		]);

		const selected = pickBestAccount(accounts, usage, { now: 0 });
		expect(selected?.email).toBe("b");
	});

	it("prefers earliest weekly reset when all accounts touched", () => {
		const accounts = [makeAccount("a"), makeAccount("b")];
		const usage = new Map([
			[
				"a",
				{
					primary: { usedPercent: 10, resetAt: 5000 },
					secondary: { usedPercent: 10, resetAt: 8000 },
					fetchedAt: 0,
				},
			],
			[
				"b",
				{
					primary: { usedPercent: 20, resetAt: 3000 },
					secondary: { usedPercent: 20, resetAt: 9000 },
					fetchedAt: 0,
				},
			],
		]);

		const selected = pickBestAccount(accounts, usage, { now: 0 });
		expect(selected?.email).toBe("a");
	});

	it("ignores 5h reset and prefers earliest weekly reset", () => {
		const accounts = [makeAccount("sh01"), makeAccount("hind")];
		const usage = new Map([
			[
				"sh01",
				{
					primary: { usedPercent: 0, resetAt: 60 * 60 * 1000 },
					secondary: { usedPercent: 9, resetAt: 5 * 24 * 60 * 60 * 1000 },
					fetchedAt: 0,
				},
			],
			[
				"hind",
				{
					primary: { usedPercent: 24, resetAt: 55 * 60 * 1000 },
					secondary: { usedPercent: 13, resetAt: 6 * 24 * 60 * 60 * 1000 },
					fetchedAt: 0,
				},
			],
		]);

		const selected = pickBestAccount(accounts, usage, { now: 0 });
		expect(selected?.email).toBe("sh01");
	});

	it("falls back to available account when usage is unknown", () => {
		const accounts = [makeAccount("a"), makeAccount("b")];
		const selected = pickBestAccount(accounts, new Map(), { now: 0 });
		expect(["a", "b"]).toContain(selected?.email);
	});

	it("ignores accounts whose server-reported window is exhausted", () => {
		const accounts = [makeAccount("a"), makeAccount("b")];
		const usage = new Map([
			[
				"a",
				{
					primary: { usedPercent: 100, resetAt: 2000 },
					secondary: { usedPercent: 0, resetAt: 3000 },
					fetchedAt: 0,
				},
			],
		]);

		const selected = pickBestAccount(accounts, usage, { now: 1000 });
		expect(selected?.email).toBe("b");
	});
});

describe("manual account selection", () => {
	let tempDir: string;
	let previousUsageLogFile: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multicodex-stream-test-"));
		previousUsageLogFile = process.env.MULTICODEX_USAGE_LOG_FILE;
		process.env.MULTICODEX_USAGE_LOG_FILE = path.join(tempDir, "usage.jsonl");
	});

	afterEach(() => {
		if (previousUsageLogFile === undefined) {
			delete process.env.MULTICODEX_USAGE_LOG_FILE;
		} else {
			process.env.MULTICODEX_USAGE_LOG_FILE = previousUsageLogFile;
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("prefers the manual account in stream wrapper", async () => {
		const manual = makeAccount("manual@example.com");
		let activateCalled = false;
		let headerEmail: string | undefined;

		const accountManager = {
			getAvailableManualAccount: () => manual,
			hasManualAccount: () => true,
			clearManualAccount: () => {},
			activateBestAccount: async () => {
				activateCalled = true;
				return undefined;
			},
			ensureValidToken: async () => "manual-token",
			refreshUsageForAccount: async () => undefined,
			handleQuotaExceeded: async () => {},
		} as unknown as AccountManager;

		const baseProvider = {
			streamSimple: (
				model: { headers?: Record<string, string> },
				_context: unknown,
				_options?: unknown,
			) => {
				headerEmail = model.headers?.["X-Multicodex-Account"];
				async function* inner() {
					yield { type: "done" };
				}
				return inner() as unknown as AsyncIterable<unknown>;
			},
		};

		const stream = createStreamWrapper(
			accountManager,
			baseProvider as unknown as BaseProvider,
		)(
			{
				id: "test",
				provider: "multicodex",
				api: "multicodex-codex-responses",
			} as StreamModel,
			{} as StreamContext,
		);

		for await (const _event of stream) {
			// drain
		}

		expect(activateCalled).toBe(false);
		expect(headerEmail).toBe("manual@example.com");
	});

	it("falls back to auto selection when manual is unavailable", async () => {
		const auto = makeAccount("auto@example.com");
		let cleared = false;
		let headerEmail: string | undefined;

		const accountManager = {
			getAvailableManualAccount: () => undefined,
			hasManualAccount: () => true,
			clearManualAccount: () => {
				cleared = true;
			},
			activateBestAccount: async () => auto,
			ensureValidToken: async () => "auto-token",
			refreshUsageForAccount: async () => undefined,
			handleQuotaExceeded: async () => {},
		} as unknown as AccountManager;

		const baseProvider = {
			streamSimple: (
				model: { headers?: Record<string, string> },
				_context: unknown,
				_options?: unknown,
			) => {
				headerEmail = model.headers?.["X-Multicodex-Account"];
				async function* inner() {
					yield { type: "done" };
				}
				return inner() as unknown as AsyncIterable<unknown>;
			},
		};

		const stream = createStreamWrapper(
			accountManager,
			baseProvider as unknown as BaseProvider,
		)(
			{
				id: "test",
				provider: "multicodex",
				api: "multicodex-codex-responses",
			} as StreamModel,
			{} as StreamContext,
		);

		for await (const _event of stream) {
			// drain
		}

		expect(cleared).toBe(true);
		expect(headerEmail).toBe("auto@example.com");
	});

	it("clears manual on quota and retries with auto account", async () => {
		const manual = makeAccount("manual@example.com");
		const auto = makeAccount("auto@example.com");
		let cleared = false;
		let activateCount = 0;
		const headers: string[] = [];
		let streamCalls = 0;

		const accountManager = {
			getAvailableManualAccount: () => (cleared ? undefined : manual),
			hasManualAccount: () => !cleared,
			clearManualAccount: () => {
				cleared = true;
			},
			activateBestAccount: async () => {
				activateCount += 1;
				return auto;
			},
			ensureValidToken: async (account: Account) => `${account.email}-token`,
			refreshUsageForAccount: async () => undefined,
			handleQuotaExceeded: async () => {},
		} as unknown as AccountManager;

		const baseProvider = {
			streamSimple: (
				model: { headers?: Record<string, string> },
				_context: unknown,
				_options?: unknown,
			) => {
				headers.push(model.headers?.["X-Multicodex-Account"] || "");
				streamCalls += 1;
				async function* inner() {
					if (streamCalls === 1) {
						yield { type: "error", error: { errorMessage: "quota exceeded" } };
						return;
					}
					yield { type: "done" };
				}
				return inner() as unknown as AsyncIterable<unknown>;
			},
		};

		const stream = createStreamWrapper(
			accountManager,
			baseProvider as unknown as BaseProvider,
		)(
			{
				id: "test",
				provider: "multicodex",
				api: "multicodex-codex-responses",
			} as StreamModel,
			{} as StreamContext,
		);

		for await (const _event of stream) {
			// drain
		}

		expect(cleared).toBe(true);
		expect(headers[0]).toBe("manual@example.com");
		expect(headers[1]).toBe("auto@example.com");
		expect(activateCount).toBe(1);
	});
});
