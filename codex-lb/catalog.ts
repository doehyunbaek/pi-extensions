import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";

export const PROVIDER = "doehyunbaek-llm";
type RecordValue = Record<string, any>;
function object(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function positive(...values: unknown[]): number | undefined {
  return values.find((v): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0);
}

/** Unknown limits use conservative client defaults, not inferred model capabilities. */
export function parseCatalog(payload: unknown, baseUrl: string): Model<"openai-responses">[] {
  const data = object(payload).data;
  if (!Array.isArray(data) || data.length === 0) throw new Error("codex-lb: empty or invalid model catalog");
  const ids = new Set<string>();
  return data.map((value) => {
    const row = object(value);
    if (typeof row.id !== "string" || !row.id.trim() || ids.has(row.id)) {
      throw new Error("codex-lb: invalid or duplicate model ID");
    }
    ids.add(row.id);
    const meta = object(row.metadata);
    const caps = object(row.capabilities);
    const levels = Array.isArray(meta.supported_reasoning_levels)
      ? meta.supported_reasoning_levels.map((level: unknown) => object(level).effort)
      : [];
    const reasoning = row.supports_reasoning === true || caps.supports_reasoning === true || levels.length > 0;
    const thinkingLevelMap: ThinkingLevelMap = {};
    if (levels.length) {
      for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
        thinkingLevelMap[level] = levels.includes(level) ? level : null;
      }
    }
    const modalities = meta.input_modalities ?? caps.input_modalities;
    const images = Array.isArray(modalities) ? modalities.includes("image") : caps.supports_images === true;
    const contextWindow = positive(meta.context_window, row.context_length, caps.context_length) ?? 128000;
    return {
      id: row.id,
      name: typeof meta.display_name === "string" ? meta.display_name : row.id,
      provider: PROVIDER,
      api: "openai-responses",
      baseUrl,
      reasoning,
      ...(levels.length ? { thinkingLevelMap } : {}),
      input: images ? ["text", "image"] : ["text"],
      contextWindow,
      maxTokens: Math.min(positive(meta.max_output_tokens, row.max_output_tokens, caps.max_output_tokens) ?? 16384, contextWindow),
      // The gateway does not supply prices. Zero means untracked, not necessarily free.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  });
}
