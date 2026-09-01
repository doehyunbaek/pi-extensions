import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import autogist, {
	hashFile,
	hasInteractiveMarker,
	listViewerSessions,
	readViewerSession,
} from "./index";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "autogist-test-"));
	tempDirs.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		tempDirs
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("lightweight session viewer metadata", () => {
	it("does not materialize oversized transcript lines", async () => {
		const directory = await tempDir();
		const path = join(directory, "large.jsonl");
		const largeAssistantText = "x".repeat(2 * 1024 * 1024);
		const lines = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "session-id",
				timestamp: "2026-09-01T00:00:00.000Z",
				cwd: "/project",
			}),
			JSON.stringify({
				type: "message",
				id: "user",
				parentId: null,
				timestamp: "2026-09-01T00:00:01.000Z",
				message: { role: "user", content: "short prompt" },
			}),
			JSON.stringify({
				type: "message",
				id: "assistant",
				parentId: "user",
				timestamp: "2026-09-01T00:00:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: largeAssistantText }],
				},
			}),
			JSON.stringify({
				type: "session_info",
				id: "name",
				parentId: "assistant",
				timestamp: "2026-09-01T00:00:03.000Z",
				name: "Latest name",
			}),
		];
		await writeFile(path, `${lines.join("\n")}\n`);

		const session = await readViewerSession(path);
		expect(session).toMatchObject({
			path,
			id: "session-id",
			cwd: "/project",
			name: "Latest name",
			firstMessage: "short prompt",
		});
		expect(JSON.stringify(session)).not.toContain(
			largeAssistantText.slice(0, 1000),
		);
	});

	it("lists nested and root sessions using bounded rows", async () => {
		const directory = await tempDir();
		const nested = join(directory, "project");
		await mkdir(nested, { recursive: true });
		for (const [path, id] of [
			[join(directory, "root.jsonl"), "root"],
			[join(nested, "nested.jsonl"), "nested"],
		] as const) {
			await writeFile(
				path,
				`${JSON.stringify({ type: "session", version: 3, id, cwd: "/project" })}\n`,
			);
		}

		const sessions = await listViewerSessions(directory);
		expect(sessions.map((session) => session.id).sort()).toEqual([
			"nested",
			"root",
		]);
	});
});

describe("interactive session marker", () => {
	it("recognizes only the Autogist custom marker", () => {
		expect(
			hasInteractiveMarker([
				{ type: "message", message: { role: "user" } },
				{ type: "custom", customType: "another-extension" },
			]),
		).toBe(false);
		expect(
			hasInteractiveMarker([
				{ type: "custom", customType: "autogist-interactive-session" },
			]),
		).toBe(true);
	});

	it("persists one marker only for terminal input", async () => {
		const handlers = new Map<string, (...args: never[]) => unknown>();
		const appended: Array<{ customType: string; data: unknown }> = [];
		autogist({
			on: (event: string, handler: (...args: never[]) => unknown) =>
				handlers.set(event, handler),
			registerCommand: () => {},
			appendEntry: (customType: string, data: unknown) =>
				appended.push({ customType, data }),
		} as never);
		const sessionStart = handlers.get("session_start");
		const input = handlers.get("input");
		expect(sessionStart).toBeDefined();
		expect(input).toBeDefined();
		await sessionStart?.(
			{} as never,
			{
				sessionManager: {
					getEntries: () => [],
					getSessionFile: () => undefined,
				},
			} as never,
		);
		input?.({ source: "rpc" } as never);
		input?.({ source: "extension" } as never);
		expect(appended).toHaveLength(0);
		input?.({ source: "interactive" } as never);
		input?.({ source: "interactive" } as never);
		expect(appended).toHaveLength(1);
		expect(appended[0]?.customType).toBe("autogist-interactive-session");
	});
});

describe("streaming file hashing", () => {
	it("matches a direct sha256 digest", async () => {
		const directory = await tempDir();
		const path = join(directory, "content.bin");
		const content = Buffer.alloc(2 * 1024 * 1024, 0xab);
		await writeFile(path, content);
		expect(await hashFile(path)).toBe(
			createHash("sha256").update(content).digest("hex"),
		);
	});
});
