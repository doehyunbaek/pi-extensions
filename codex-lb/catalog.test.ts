import assert from "node:assert/strict";
import test from "node:test";
import { parseCatalog } from "./catalog.ts";

const url = "https://example.com/v1";
test("maps discovery metadata and disables unsupported thinking levels", () => {
  const [model] = parseCatalog({ data: [{ id: "new-model", metadata: {
    display_name: "New Model", context_window: 500000, input_modalities: ["text", "image"],
    supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }, { effort: "ultra" }],
  } }] }, url);
  assert.equal(model.name, "New Model");
  assert.equal(model.contextWindow, 500000);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.reasoning, true);
  assert.equal(model.thinkingLevelMap?.low, "low");
  assert.equal(model.thinkingLevelMap?.medium, null);
  assert.equal(model.thinkingLevelMap?.max, "max");
  assert.equal(model.maxTokens, 16384);
});
test("uses conservative defaults and caps output to context", () => {
  const [model] = parseCatalog({ data: [{ id: "plain", context_length: 8192, max_output_tokens: null }] }, url);
  assert.equal(model.maxTokens, 8192);
  assert.equal(model.reasoning, false);
  assert.deepEqual(model.input, ["text"]);
});
test("does not overwrite working catalogs with malformed/empty responses", () => {
  for (const payload of [null, {}, { data: [] }, { data: [{}] }, { data: [{ id: "x" }, { id: "x" }] }]) {
    assert.throws(() => parseCatalog(payload, url));
  }
});
