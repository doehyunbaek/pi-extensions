import { createHash } from "node:crypto";
import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "pi-system-prompt-snapshot";

interface DynamicPromptParts {
	appended: string[];
	generated: string[];
}

interface SystemPromptSnapshot {
	version: 1;
	prompt: string;
	sha256: string;
	capturedAt: string;
	model?: {
		provider: string;
		id: string;
	};
	thinkingLevel: string;
	dynamicParts?: DynamicPromptParts;
}

function isSnapshotEntry(entry: CustomEntry): entry is CustomEntry<SystemPromptSnapshot> {
	if (entry.customType !== ENTRY_TYPE || !entry.data || typeof entry.data !== "object") {
		return false;
	}

	const data = entry.data as Partial<SystemPromptSnapshot>;
	return data.version === 1 && typeof data.prompt === "string" && typeof data.sha256 === "string";
}

function getLatestSnapshot(ctx: ExtensionContext): SystemPromptSnapshot | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "custom" && isSnapshotEntry(entry)) {
			return entry.data;
		}
	}
	return undefined;
}

function getDynamicParts(options: {
	selectedTools?: string[];
	toolSnippets?: Record<string, string>;
	promptGuidelines?: string[];
	appendSystemPrompt?: string;
	contextFiles?: Array<{ path: string; content: string }>;
}): DynamicPromptParts {
	const generated: string[] = [];
	for (const name of options.selectedTools ?? []) {
		const snippet = options.toolSnippets?.[name];
		if (snippet) generated.push(`- ${name}: ${snippet}`);
	}
	for (const guideline of options.promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized) generated.push(`- ${normalized}`);
	}
	for (const file of options.contextFiles ?? []) {
		generated.push(`<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`);
	}
	return {
		appended: options.appendSystemPrompt ? [options.appendSystemPrompt] : [],
		generated,
	};
}

function highlightDynamicParts(prompt: string, parts: DynamicPromptParts | undefined, ctx: ExtensionContext): string {
	if (!parts) return prompt;

	const ranges: Array<{ start: number; end: number }> = [];
	for (const part of [...parts.appended, ...parts.generated]) {
		if (!part) continue;
		let start = 0;
		while ((start = prompt.indexOf(part, start)) !== -1) {
			ranges.push({ start, end: start + part.length });
			start += part.length;
		}
	}
	if (ranges.length === 0) return prompt;

	ranges.sort((a, b) => a.start - b.start || b.end - a.end);
	const merged: Array<{ start: number; end: number }> = [];
	for (const range of ranges) {
		const previous = merged.at(-1);
		if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
		else merged.push({ ...range });
	}

	let result = "";
	let offset = 0;
	for (const range of merged) {
		result += prompt.slice(offset, range.start);
		result += ctx.ui.theme.bg("selectedBg", ctx.ui.theme.fg("accent", prompt.slice(range.start, range.end)));
		offset = range.end;
	}
	return result + prompt.slice(offset);
}

function formatSnapshot(
	snapshot: SystemPromptSnapshot,
	ctx: ExtensionContext,
	fallbackDynamicParts?: DynamicPromptParts,
): string {
	const model = snapshot.model ? `${snapshot.model.provider}/${snapshot.model.id}` : "no model";
	const prompt = highlightDynamicParts(snapshot.prompt, snapshot.dynamicParts ?? fallbackDynamicParts, ctx);
	return `Persisted system prompt snapshot\nCaptured: ${snapshot.capturedAt}\nModel: ${model}\nThinking: ${snapshot.thinkingLevel}\nSHA-256: ${snapshot.sha256}\nDynamic sections: highlighted background\n\n${prompt}`;
}

function formatCurrentPrompt(ctx: ExtensionContext, dynamicParts?: DynamicPromptParts): string {
	const prompt = ctx.getSystemPrompt();
	const sha256 = createHash("sha256").update(prompt).digest("hex");
	return `Current reconstructed system prompt\nSHA-256: ${sha256}\nDynamic sections: highlighted background\n\n${highlightDynamicParts(prompt, dynamicParts, ctx)}`;
}

function showLatestSnapshot(ctx: ExtensionContext, currentDynamicParts?: DynamicPromptParts): void {
	const snapshot = getLatestSnapshot(ctx);
	ctx.ui.notify(
		snapshot ? formatSnapshot(snapshot, ctx, currentDynamicParts) : formatCurrentPrompt(ctx, currentDynamicParts),
		"info",
	);
}

export default function (pi: ExtensionAPI) {
	let currentDynamicParts: DynamicPromptParts | undefined;

	pi.on("before_agent_start", (event) => {
		currentDynamicParts = getDynamicParts(event.systemPromptOptions);
	});

	pi.on("agent_start", (_event, ctx) => {
		const prompt = ctx.getSystemPrompt();
		pi.appendEntry<SystemPromptSnapshot>(ENTRY_TYPE, {
			version: 1,
			prompt,
			sha256: createHash("sha256").update(prompt).digest("hex"),
			capturedAt: new Date().toISOString(),
			model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
			thinkingLevel: pi.getThinkingLevel(),
			dynamicParts: currentDynamicParts,
		});
	});

	pi.registerCommand("system-prompt", {
		description: "Show the latest persisted system prompt; use 'current' for the reconstructed prompt",
		handler: async (args, ctx) => {
			const mode = args.trim();
			if (mode === "current") {
				ctx.ui.notify(formatCurrentPrompt(ctx, getDynamicParts(ctx.getSystemPromptOptions())), "info");
				return;
			}

			if (mode && mode !== "saved" && mode !== "latest") {
				ctx.ui.notify("Usage: /system-prompt [saved|latest|current]", "warning");
				return;
			}

			showLatestSnapshot(ctx, getDynamicParts(ctx.getSystemPromptOptions()));
		},
	});

}
