import * as fs from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:util", () => ({
	promisify:
		() => async (command: string, args: string[], options: unknown) => ({
			stdout: await execute(command, args, options),
			stderr: "",
		}),
}));

import { createSecretGist } from "./gist-sync";

const gist = (id: string, created_at = "2026-01-01T00:00:00Z") => ({
	id,
	created_at,
	description: "MultiCodex account sync",
	public: false,
	owner: { id: 123 },
	files: { "multicodex.json": {} },
});
beforeEach(() => {
	execute.mockReset();
});

it("authenticates identity and discovers across pages without creating a copy", async () => {
	execute.mockImplementation((_command, args: string[]) => {
		if (args[0] === "auth") return "";
		if (args.includes("user")) return JSON.stringify({ id: 123 });
		if (args.includes("gists?per_page=100&page=1"))
			return JSON.stringify(
				Array.from({ length: 100 }, (_, i) => ({
					...gist(i.toString(16)),
					description: "unrelated",
				})),
			);
		if (args.includes("gists?per_page=100&page=2"))
			return JSON.stringify([gist("def", "2026-02-01T00:00:00Z"), gist("abc")]);
		throw new Error("Unexpected creation");
	});
	await expect(createSecretGist()).resolves.toBe("abc");
	expect(execute.mock.calls.some((call) => call[1].includes("POST"))).toBe(
		false,
	);
});

it("creates only a secret empty Gist with numeric identity, then converges after a concurrent creation", async () => {
	let lists = 0;
	execute.mockImplementation((_command, args: string[]) => {
		if (args[0] === "auth") return "";
		if (args.includes("user")) return JSON.stringify({ id: 123 });
		if (args.includes("gists?per_page=100&page=1"))
			return JSON.stringify(
				++lists === 1 ? [] : [gist("abc"), gist("def", "2026-02-01T00:00:00Z")],
			);
		if (args.includes("POST")) {
			const request = JSON.parse(
				fs.readFileSync(args[args.indexOf("--input") + 1], "utf8"),
			);
			expect(request.public).toBe(false);
			expect(request.description).toBe("MultiCodex account sync (github:123)");
			expect(JSON.parse(request.files["multicodex.json"].content)).toEqual({
				accounts: [],
			});
			return JSON.stringify({ id: "def", public: false });
		}
		throw new Error("Unexpected request");
	});
	await expect(createSecretGist()).resolves.toBe("abc");
});

it("fails closed on discovery errors rather than creating another Gist", async () => {
	execute.mockImplementation((_command, args: string[]) => {
		if (args[0] === "auth") return "";
		if (args.includes("user")) return JSON.stringify({ id: 123 });
		throw new Error("Network failure");
	});
	await expect(createSecretGist()).rejects.toThrow("discover");
	expect(execute.mock.calls.some((call) => call[1].includes("POST"))).toBe(
		false,
	);
});
