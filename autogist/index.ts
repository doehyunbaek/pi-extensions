import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

interface BackupRecord {
	gistId: string;
	gistUrl: string;
	filename: string;
	sha256: string;
	updatedAt: string;
}

interface StoredBackup {
	version: 1;
	sessionFile: string;
	record: BackupRecord;
}

interface GistResponse {
	id: string;
	html_url: string;
}

interface AutogistConfig {
	version: 1;
	deviceName?: string;
}

interface CooldownState {
	version: 1;
	until: string;
	reason: string;
}

class SecondaryRateLimitError extends Error {
	constructor(
		message: string,
		readonly cooldownUntil: Date,
	) {
		super(message);
		this.name = "SecondaryRateLimitError";
	}
}

type SyncStatus = "synchronized" | "pending";

interface ViewerSession {
	path: string;
	id: string;
	cwd: string;
	modified: Date;
	name?: string;
	firstMessage?: string;
}

const METADATA_CONCURRENCY = 8;
const FIRST_MESSAGE_LIMIT = 240;
const MAX_METADATA_LINE_BYTES = 64 * 1024;

const AGENT_DIR = join(homedir(), ".pi", "agent");
const STATE_DIR = join(AGENT_DIR, "autogist");
const SESSIONS_DIR = join(AGENT_DIR, "sessions");
const CONFIG_PATH = join(STATE_DIR, "config.json");
const COOLDOWN_PATH = join(STATE_DIR, "cooldown.json");
const DESCRIPTION_PREFIX = "Pi session backup";
const INTERACTIVE_MARKER_TYPE = "autogist-interactive-session";
const BATCH_CONCURRENCY = 1;
const MIN_REQUEST_INTERVAL_MS = 2_000;
const SECONDARY_LIMIT_COOLDOWN_MS = 60 * 60 * 1_000;
let nextRequestAt = 0;
let pacingQueue = Promise.resolve();

function normalizeDeviceName(value: string): string {
	return value
		.trim()
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function gistFilename(
	sessionFile: string,
	sessionId: string,
	deviceName?: string,
): string {
	const stem = basename(sessionFile, ".jsonl").replace(/[^a-zA-Z0-9._-]/g, "-");
	const timestamp = stem.includes("_")
		? stem.slice(0, stem.lastIndexOf("_"))
		: stem;
	const prefix = deviceName ? `${deviceName}__` : "";
	return `${prefix}${timestamp}__${sessionId.slice(0, 8)}.jsonl`;
}

async function loadConfig(): Promise<AutogistConfig> {
	try {
		const config = JSON.parse(
			await readFile(CONFIG_PATH, "utf8"),
		) as Partial<AutogistConfig>;
		if (config.version === 1) {
			return {
				version: 1,
				deviceName:
					typeof config.deviceName === "string"
						? normalizeDeviceName(config.deviceName) || undefined
						: undefined,
			};
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return { version: 1 };
}

async function saveConfig(config: AutogistConfig): Promise<void> {
	await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
	const temporaryPath = `${CONFIG_PATH}.${process.pid}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
		mode: 0o600,
	});
	await rename(temporaryPath, CONFIG_PATH);
}

async function loadCooldown(): Promise<CooldownState | undefined> {
	try {
		const state = JSON.parse(
			await readFile(COOLDOWN_PATH, "utf8"),
		) as Partial<CooldownState>;
		if (state.version === 1 && state.until && state.reason) {
			if (new Date(state.until).getTime() > Date.now())
				return state as CooldownState;
			await unlink(COOLDOWN_PATH).catch(() => undefined);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return undefined;
}

async function saveCooldown(reason: string): Promise<Date> {
	await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
	const until = new Date(Date.now() + SECONDARY_LIMIT_COOLDOWN_MS);
	const state: CooldownState = {
		version: 1,
		until: until.toISOString(),
		reason,
	};
	const temporaryPath = `${COOLDOWN_PATH}.${process.pid}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
		mode: 0o600,
	});
	await rename(temporaryPath, COOLDOWN_PATH);
	return until;
}

function recordPath(sessionFile: string): string {
	const key = createHash("sha256").update(sessionFile).digest("hex");
	return join(STATE_DIR, `${key}.json`);
}

async function loadRecord(
	sessionFile: string,
): Promise<BackupRecord | undefined> {
	try {
		const parsed = JSON.parse(
			await readFile(recordPath(sessionFile), "utf8"),
		) as Partial<StoredBackup>;
		if (
			parsed.version === 1 &&
			parsed.sessionFile === sessionFile &&
			parsed.record?.gistId
		)
			return parsed.record;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return undefined;
}

async function listFiles(directory: string, suffix: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}

	const files: string[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(path, suffix)));
		else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(path);
	}
	return files;
}

async function loadAllRecords(): Promise<Map<string, BackupRecord>> {
	const records = new Map<string, BackupRecord>();
	for (const path of await listFiles(STATE_DIR, ".json")) {
		try {
			const stored = JSON.parse(
				await readFile(path, "utf8"),
			) as Partial<StoredBackup>;
			if (stored.version === 1 && stored.sessionFile && stored.record?.gistId) {
				records.set(stored.sessionFile, stored.record);
			}
		} catch {
			// Ignore malformed records here; individual session status still reports errors.
		}
	}
	return records;
}

function messagePreview(content: unknown): string | undefined {
	let text: string | undefined;
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		text = content
			.filter(
				(part): part is { type: "text"; text: string } =>
					typeof part === "object" &&
					part !== null &&
					(part as { type?: unknown }).type === "text" &&
					typeof (part as { text?: unknown }).text === "string",
			)
			.map((part) => part.text)
			.join(" ");
	}
	if (!text) return undefined;
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > FIRST_MESSAGE_LIMIT
		? `${compact.slice(0, FIRST_MESSAGE_LIMIT - 1)}…`
		: compact;
}

async function* readBoundedLines(path: string): AsyncGenerator<string> {
	let buffered = "";
	let oversized = false;
	for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
		let start = 0;
		let newline = chunk.indexOf("\n");
		while (newline >= 0) {
			const segment = chunk.slice(start, newline);
			if (!oversized) {
				const remaining = MAX_METADATA_LINE_BYTES - buffered.length;
				if (segment.length <= remaining) buffered += segment;
				else oversized = true;
			}
			if (!oversized)
				yield buffered.endsWith("\r") ? buffered.slice(0, -1) : buffered;
			buffered = "";
			oversized = false;
			start = newline + 1;
			newline = chunk.indexOf("\n", start);
		}
		if (!oversized) {
			const segment = chunk.slice(start);
			const remaining = MAX_METADATA_LINE_BYTES - buffered.length;
			if (segment.length <= remaining) buffered += segment;
			else oversized = true;
		}
	}
	if (!oversized && buffered) yield buffered;
}

/** Read only bounded fields needed by the viewer; never retain transcript bodies. */
export async function readViewerSession(
	path: string,
): Promise<ViewerSession | undefined> {
	let id: string | undefined;
	let cwd: string | undefined;
	let name: string | undefined;
	let firstMessage: string | undefined;
	for await (const line of readBoundedLines(path)) {
		if (
			id === undefined ||
			line.includes('"type":"session_info"') ||
			(firstMessage === undefined && line.includes('"role":"user"'))
		) {
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (entry.type === "session") {
				if (typeof entry.id === "string") id = entry.id;
				if (typeof entry.cwd === "string") cwd = entry.cwd;
			} else if (entry.type === "session_info") {
				name = typeof entry.name === "string" ? entry.name : undefined;
			} else if (entry.type === "message") {
				const message = entry.message as
					| { role?: unknown; content?: unknown }
					| undefined;
				if (message?.role === "user")
					firstMessage = messagePreview(message.content);
			}
		}
	}
	if (!id || !cwd) return undefined;
	const fileStat = await stat(path);
	return { path, id, cwd, modified: fileStat.mtime, name, firstMessage };
}

async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	mapper: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await mapper(items[index] as T);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, () => worker()),
	);
	return results;
}

export async function listViewerSessions(
	sessionsDir = SESSIONS_DIR,
): Promise<ViewerSession[]> {
	const files = await listFiles(sessionsDir, ".jsonl");
	const sessions = await mapLimit(files, METADATA_CONCURRENCY, async (path) => {
		try {
			return await readViewerSession(path);
		} catch {
			return undefined;
		}
	});
	return sessions
		.filter((session): session is ViewerSession => session !== undefined)
		.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function getSyncStatus(
	session: ViewerSession,
	config: AutogistConfig,
	records: Map<string, BackupRecord>,
): Promise<SyncStatus> {
	const record = records.get(session.path);
	if (!record) return "pending";
	try {
		const sha256 = await hashFile(session.path);
		const expectedFilename = gistFilename(
			session.path,
			session.id,
			config.deviceName,
		);
		return sha256 === record.sha256 && record.filename === expectedFilename
			? "synchronized"
			: "pending";
	} catch {
		return "pending";
	}
}

async function analyzeBackups(): Promise<{
	total: number;
	synchronized: number;
	pending: number;
	missingLocal: number;
}> {
	const records = await loadAllRecords();
	const sessionFiles = await listFiles(SESSIONS_DIR, ".jsonl");
	let synchronized = 0;
	let pending = 0;

	for (const sessionFile of sessionFiles) {
		const record = records.get(sessionFile);
		if (!record) {
			pending++;
			continue;
		}
		try {
			const sha256 = await hashFile(sessionFile);
			if (sha256 === record.sha256) synchronized++;
			else pending++;
		} catch {
			pending++;
		}
	}

	const localFiles = new Set(sessionFiles);
	const missingLocal = [...records.keys()].filter(
		(path) => !localFiles.has(path),
	).length;
	return { total: sessionFiles.length, synchronized, pending, missingLocal };
}

async function saveRecord(
	sessionFile: string,
	record: BackupRecord,
): Promise<void> {
	await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
	const path = recordPath(sessionFile);
	const temporaryPath = `${path}.${process.pid}.tmp`;
	const stored: StoredBackup = { version: 1, sessionFile, record };
	await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
		mode: 0o600,
	});
	await rename(temporaryPath, path);
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isSecondaryRateLimit(error: unknown): boolean {
	return /secondary rate limit|temporarily blocked from content creation/i.test(
		errorMessage(error),
	);
}

function isTransientGhError(error: unknown): boolean {
	return /HTTP (?:429|5\d\d)|server error|timeout|timed out|ECONNRESET|ECONNREFUSED|socket hang up|network/i.test(
		errorMessage(error),
	);
}

async function waitForRequestSlot(): Promise<void> {
	const slot = pacingQueue
		.catch(() => undefined)
		.then(async () => {
			const cooldown = await loadCooldown();
			if (cooldown) {
				throw new SecondaryRateLimitError(
					`GitHub content creation is paused until ${cooldown.until}`,
					new Date(cooldown.until),
				);
			}
			const delay = Math.max(0, nextRequestAt - Date.now());
			if (delay > 0) await sleep(delay);
			nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
		});
	pacingQueue = slot.catch(() => undefined);
	await slot;
}

async function runGhApiOnce(
	path: string,
	method: "POST" | "PATCH",
	payload: unknown,
): Promise<GistResponse> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"gh",
			["api", "--method", method, path, "--input", "-"],
			{
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => (stdout += chunk));
		child.stderr.on("data", (chunk: string) => (stderr += chunk));
		child.on("error", (error) =>
			reject(new Error(`Could not run gh: ${error.message}`)),
		);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(stderr.trim() || `gh exited with status ${code}`));
				return;
			}
			try {
				const response = JSON.parse(stdout) as Partial<GistResponse>;
				if (!response.id || !response.html_url)
					throw new Error("GitHub returned an incomplete gist response");
				resolve(response as GistResponse);
			} catch (error) {
				reject(error);
			}
		});
		child.stdin.end(JSON.stringify(payload));
	});
}

async function runGhApi(
	path: string,
	method: "POST" | "PATCH",
	payload: unknown,
): Promise<GistResponse> {
	const maxAttempts = 4;
	let lastFailure: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			await waitForRequestSlot();
			return await runGhApiOnce(path, method, payload);
		} catch (error) {
			lastFailure = error;
			if (error instanceof SecondaryRateLimitError) throw error;
			if (isSecondaryRateLimit(error)) {
				const cooldownUntil = await saveCooldown(errorMessage(error));
				throw new SecondaryRateLimitError(
					`GitHub secondary rate limit reached; sync paused until ${cooldownUntil.toISOString()}`,
					cooldownUntil,
				);
			}
			if (attempt === maxAttempts || !isTransientGhError(error)) throw error;
			const backoff = 500 * 2 ** (attempt - 1);
			const jitter = Math.floor(Math.random() * 250);
			await sleep(backoff + jitter);
		}
	}
	throw lastFailure;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function hasInteractiveMarker(entries: readonly unknown[]): boolean {
	return entries.some(
		(entry) =>
			typeof entry === "object" &&
			entry !== null &&
			(entry as { type?: unknown }).type === "custom" &&
			(entry as { customType?: unknown }).customType ===
				INTERACTIVE_MARKER_TYPE,
	);
}

export default function (pi: ExtensionAPI) {
	const sessionQueues = new Map<string, Promise<BackupRecord | undefined>>();
	let lastError: string | undefined;
	let lastRecord: BackupRecord | undefined;
	let interactiveSession = false;

	const syncFile = (
		sessionFile: string,
		sessionId: string,
		sessionCwd: string,
		force = false,
	): Promise<BackupRecord | undefined> => {
		const task = async (): Promise<BackupRecord | undefined> => {
			let content: string;
			try {
				content = await readFile(sessionFile, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT")
					return undefined;
				throw error;
			}
			if (content.length === 0) return undefined;
			const sha256 = createHash("sha256").update(content).digest("hex");
			const existing = await loadRecord(sessionFile);
			const { deviceName } = await loadConfig();
			const filename = gistFilename(sessionFile, sessionId, deviceName);
			if (
				!force &&
				existing?.sha256 === sha256 &&
				existing.filename === filename
			) {
				lastRecord = existing;
				lastError = undefined;
				return existing;
			}

			const deviceDescription = deviceName ? ` on ${deviceName}` : "";
			const description = `${DESCRIPTION_PREFIX} ${sessionId}${deviceDescription} (${sessionCwd})`;
			const files: Record<string, { content: string } | null> = {
				[filename]: { content },
			};
			if (existing && existing.filename !== filename)
				files[existing.filename] = null;
			let response: GistResponse;
			try {
				response = existing
					? await runGhApi(`gists/${existing.gistId}`, "PATCH", {
							description,
							files,
						})
					: await runGhApi("gists", "POST", {
							description,
							public: false,
							files,
						});
			} catch (error) {
				// A remotely deleted gist should be recreated on the next sync after its local record is removed.
				if (existing && /404|not found/i.test(errorMessage(error))) {
					await unlink(recordPath(sessionFile)).catch(() => undefined);
				}
				throw error;
			}

			const record: BackupRecord = {
				gistId: response.id,
				gistUrl: response.html_url,
				filename,
				sha256,
				updatedAt: new Date().toISOString(),
			};
			await saveRecord(sessionFile, record);
			lastRecord = record;
			lastError = undefined;
			return record;
		};

		const previous =
			sessionQueues.get(sessionFile) ??
			Promise.resolve<BackupRecord | undefined>(undefined);
		const queued = previous.catch(() => undefined).then(task);
		sessionQueues.set(sessionFile, queued);
		queued.then(
			() => {
				if (sessionQueues.get(sessionFile) === queued)
					sessionQueues.delete(sessionFile);
			},
			(error) => {
				lastError = errorMessage(error);
				if (sessionQueues.get(sessionFile) === queued)
					sessionQueues.delete(sessionFile);
			},
		);
		return queued;
	};

	const sync = (
		ctx: ExtensionContext,
		force = false,
	): Promise<BackupRecord | undefined> => {
		// Automatic backups are intentionally limited to sessions that received
		// terminal input. RPC/extension-generated benchmark sessions remain local.
		if (!force && !interactiveSession) return Promise.resolve(undefined);
		// Capture plain values before entering the queue. The context becomes stale
		// when Pi replaces a session, while an earlier upload may still be running.
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return Promise.resolve(undefined);
		return syncFile(
			sessionFile,
			ctx.sessionManager.getSessionId(),
			ctx.sessionManager.getCwd(),
			force,
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		interactiveSession = hasInteractiveMarker(ctx.sessionManager.getEntries());
		const sessionFile = ctx.sessionManager.getSessionFile();
		lastRecord = sessionFile ? await loadRecord(sessionFile) : undefined;
	});

	pi.on("input", (event) => {
		if (event.source !== "interactive" || interactiveSession) return;
		interactiveSession = true;
		pi.appendEntry(INTERACTIVE_MARKER_TYPE, {
			version: 1,
			markedAt: new Date().toISOString(),
		});
	});

	pi.on("agent_settled", async (_event, ctx) => {
		try {
			await sync(ctx);
		} catch (error) {
			lastError = errorMessage(error);
			ctx.ui.notify(`Autogist backup failed: ${lastError}`, "error");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			await sync(ctx);
		} catch (error) {
			lastError = errorMessage(error);
			ctx.ui.notify(`Autogist backup failed: ${lastError}`, "error");
		}
	});

	pi.registerCommand("autogist-device", {
		description: "Show or set the device-name prefix used for gist files",
		handler: async (args, ctx) => {
			const value = args.trim();
			if (!value) {
				const config = await loadConfig();
				ctx.ui.notify(
					config.deviceName
						? `Autogist device: ${config.deviceName}`
						: "No Autogist device name is configured",
					"info",
				);
				return;
			}

			if (value === "clear") {
				await saveConfig({ version: 1 });
				ctx.ui.notify("Autogist device name cleared", "info");
				return;
			}

			const deviceName = normalizeDeviceName(value);
			if (!deviceName) {
				ctx.ui.notify(
					"Device name must contain a letter, number, dot, underscore, or hyphen",
					"warning",
				);
				return;
			}
			await saveConfig({ version: 1, deviceName });
			ctx.ui.notify(
				`Autogist device set to ${deviceName}. Run /autogist sync to rename and upload the current session.`,
				"info",
			);
		},
	});

	pi.registerCommand("autogist-analyze", {
		description: "Browse session sync status and batch-sync selected sessions",
		handler: async (_args, ctx) => {
			try {
				if (ctx.mode !== "tui") {
					const analysis = await analyzeBackups();
					const percent =
						analysis.total === 0
							? 0
							: Math.round((analysis.synchronized / analysis.total) * 100);
					ctx.ui.notify(
						`Autogist synchronization: ${analysis.synchronized}/${analysis.total} (${percent}%), ${analysis.pending} pending`,
						analysis.pending > 0 ? "warning" : "info",
					);
					return;
				}

				const [allSessions, records, config] = await Promise.all([
					listViewerSessions(),
					loadAllRecords(),
					loadConfig(),
				]);
				const currentSessions = allSessions.filter(
					(session) => session.cwd === ctx.cwd,
				);
				const statuses = new Map<string, SyncStatus>();
				await mapLimit(allSessions, METADATA_CONCURRENCY, async (session) => {
					statuses.set(
						session.path,
						await getSyncStatus(session, config, records),
					);
				});

				const selectedPaths = await ctx.ui.custom<string[] | null>(
					(tui, theme, _keybindings, done) => {
						let scope: "current" | "all" = "current";
						let selectedIndex = 0;
						let scrollOffset = 0;
						const maxVisible = 15;
						const selected = new Set<string>();
						const sorted = (sessions: ViewerSession[]) =>
							[...sessions].sort(
								(a, b) => b.modified.getTime() - a.modified.getTime(),
							);
						const current = sorted(currentSessions);
						const all = sorted(allSessions);
						const visible = () => (scope === "current" ? current : all);

						return {
							invalidate() {},
							handleInput(data: string) {
								const sessions = visible();
								if (
									matchesKey(data, Key.escape) ||
									matchesKey(data, Key.ctrl("c"))
								) {
									done(null);
									return;
								}
								if (matchesKey(data, Key.tab)) {
									scope = scope === "current" ? "all" : "current";
									selectedIndex = 0;
									scrollOffset = 0;
								} else if (matchesKey(data, Key.up)) {
									selectedIndex = Math.max(0, selectedIndex - 1);
									if (selectedIndex < scrollOffset)
										scrollOffset = selectedIndex;
								} else if (matchesKey(data, Key.down)) {
									selectedIndex = Math.min(
										Math.max(0, sessions.length - 1),
										selectedIndex + 1,
									);
									if (selectedIndex >= scrollOffset + maxVisible) {
										scrollOffset = selectedIndex - maxVisible + 1;
									}
								} else if (matchesKey(data, Key.space)) {
									const session = sessions[selectedIndex];
									if (session) {
										if (selected.has(session.path))
											selected.delete(session.path);
										else selected.add(session.path);
									}
								} else if (
									matchesKey(data, "a") ||
									matchesKey(data, Key.shift("a")) ||
									matchesKey(data, Key.ctrl("a"))
								) {
									const allVisibleSelected = sessions.every((session) =>
										selected.has(session.path),
									);
									for (const session of sessions) {
										if (allVisibleSelected) selected.delete(session.path);
										else selected.add(session.path);
									}
								} else if (matchesKey(data, Key.enter) && selected.size > 0) {
									done([...selected]);
									return;
								}
								tui.requestRender();
							},
							render(width: number): string[] {
								const sessions = visible();
								const synchronized = sessions.filter(
									(session) => statuses.get(session.path) === "synchronized",
								).length;
								const scopeLabel =
									scope === "current"
										? `${theme.fg("accent", "◉ Current Folder")} ${theme.fg("muted", "○ All")}`
										: `${theme.fg("muted", "○ Current Folder")} ${theme.fg("accent", "◉ All")}`;
								const lines = [
									truncateToWidth(
										`${theme.bold("Autogist Sessions")}  ${scopeLabel}`,
										width,
									),
									truncateToWidth(
										theme.fg(
											"muted",
											`${synchronized}/${sessions.length} synchronized · ${selected.size} selected`,
										),
										width,
									),
								];
								if (sessions.length === 0) {
									lines.push(theme.fg("warning", "No sessions found"));
								} else {
									const start = Math.min(
										scrollOffset,
										Math.max(0, sessions.length - maxVisible),
									);
									for (
										let index = start;
										index < Math.min(sessions.length, start + maxVisible);
										index++
									) {
										const session = sessions[index];
										if (!session) continue;
										const checked = selected.has(session.path) ? "[x]" : "[ ]";
										const status = statuses.get(session.path);
										const statusText =
											status === "synchronized"
												? theme.fg("success", "synced")
												: theme.fg("warning", "pending");
										const label =
											session.name ||
											session.firstMessage ||
											basename(session.path);
										const row = `${checked} ${statusText}  ${label}  ${theme.fg("dim", session.cwd)}`;
										const cursor =
											index === selectedIndex ? theme.fg("accent", "> ") : "  ";
										lines.push(truncateToWidth(`${cursor}${row}`, width));
									}
								}
								lines.push(
									truncateToWidth(
										theme.fg(
											"dim",
											"↑↓ navigate · space select · a/ctrl+a select all · tab scope · enter sync · esc cancel",
										),
										width,
									),
								);
								return lines;
							},
						};
					},
				);
				if (!selectedPaths || selectedPaths.length === 0) return;

				const byPath = new Map(
					allSessions.map((session) => [session.path, session]),
				);
				let succeeded = 0;
				let completed = 0;
				let nextIndex = 0;
				let stoppedForRateLimit: SecondaryRateLimitError | undefined;
				const failures: string[] = [];
				const worker = async () => {
					while (nextIndex < selectedPaths.length && !stoppedForRateLimit) {
						const index = nextIndex++;
						const path = selectedPaths[index];
						const session = path ? byPath.get(path) : undefined;
						if (!session) {
							completed++;
							continue;
						}
						try {
							const record = await syncFile(
								session.path,
								session.id,
								session.cwd,
							);
							if (record) succeeded++;
							else
								failures.push(
									`${basename(session.path)}: file is empty or missing`,
								);
						} catch (error) {
							if (error instanceof SecondaryRateLimitError) {
								stoppedForRateLimit = error;
							} else {
								failures.push(
									`${basename(session.path)}: ${errorMessage(error)}`,
								);
							}
						} finally {
							completed++;
							ctx.ui.setStatus(
								"autogist",
								`syncing ${completed}/${selectedPaths.length} (${Math.min(BATCH_CONCURRENCY, selectedPaths.length)} parallel)`,
							);
						}
					}
				};
				ctx.ui.setStatus(
					"autogist",
					`syncing 0/${selectedPaths.length} (${Math.min(BATCH_CONCURRENCY, selectedPaths.length)} parallel)`,
				);
				await Promise.all(
					Array.from(
						{ length: Math.min(BATCH_CONCURRENCY, selectedPaths.length) },
						() => worker(),
					),
				);
				ctx.ui.setStatus("autogist", undefined);
				const remaining = selectedPaths.length - succeeded;
				const failurePreview = failures.slice(0, 5).join("\n");
				const omitted =
					failures.length > 5 ? `\n…and ${failures.length - 5} more` : "";
				const rateLimitMessage = stoppedForRateLimit
					? `\nPaused by GitHub until ${stoppedForRateLimit.cooldownUntil.toISOString()}. ${remaining} session(s) remain pending.`
					: "";
				const failureMessage = failurePreview
					? `\n${failurePreview}${omitted}`
					: "";
				ctx.ui.notify(
					`Synchronized ${succeeded}/${selectedPaths.length} session(s)${rateLimitMessage}${failureMessage}`,
					stoppedForRateLimit || failures.length > 0 ? "warning" : "info",
				);
			} catch (error) {
				ctx.ui.setStatus("autogist", undefined);
				ctx.ui.notify(
					`Autogist analysis failed: ${errorMessage(error)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("autogist", {
		description:
			"Show autogist status or run a backup: /autogist [status|sync]",
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (action === "sync") {
				try {
					const record = await sync(ctx, true);
					ctx.ui.notify(
						record
							? `Session backed up to ${record.gistUrl}`
							: "This session has no persisted data to back up",
						"info",
					);
				} catch (error) {
					lastError = errorMessage(error);
					ctx.ui.notify(`Autogist backup failed: ${lastError}`, "error");
				}
				return;
			}
			if (action !== "status") {
				ctx.ui.notify("Usage: /autogist [status|sync]", "warning");
				return;
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			const record = sessionFile
				? ((await loadRecord(sessionFile)) ?? lastRecord)
				: undefined;
			const automaticStatus = interactiveSession
				? "Automatic backup: enabled (interactive session)"
				: "Automatic backup: disabled (no interactive input marker)";
			const status = !sessionFile
				? "Autogist is inactive for this in-memory session"
				: record
					? `Autogist: ${record.gistUrl}\nLast backup: ${record.updatedAt}\nFile: ${record.filename}\n${automaticStatus}`
					: `Autogist has not backed up this session yet\n${automaticStatus}`;
			ctx.ui.notify(
				lastError ? `${status}\nLast error: ${lastError}` : status,
				lastError ? "warning" : "info",
			);
		},
	});
}
