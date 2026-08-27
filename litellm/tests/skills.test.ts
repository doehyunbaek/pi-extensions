import type { Static, TSchema } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSkillsPromptSection,
  createSkillToolDefinitions,
  deleteSkill,
  listSkills,
  resetSkillsCache,
} from "../src/skills.js";
import type { LiteLLMSkill } from "../src/types.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  resetSkillsCache();
  vi.restoreAllMocks();
});

describe("listSkills", () => {
  it("returns skills from the LiteLLM Skills Gateway", async () => {
    const skills: LiteLLMSkill[] = [
      { id: "skill-1", name: "terraform", description: "Terraform conventions", enabled: true },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { data: skills }));

    await expect(listSkills("https://litellm.example.com", "sk-test")).resolves.toEqual(skills);
  });

  it("uses a short in-memory cache for repeated reads", async () => {
    const skills: LiteLLMSkill[] = [{ id: "skill-1", name: "terraform", description: "Terraform conventions" }];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, skills));

    await expect(listSkills("https://litellm.example.com", "sk-test")).resolves.toEqual(skills);
    await expect(listSkills("https://litellm.example.com", "sk-test")).resolves.toEqual(skills);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("skill helpers", () => {
  it("deletes skills by id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    await expect(deleteSkill("https://litellm.example.com", "sk-test", "skill-1")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://litellm.example.com/v1/skills/skill-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("formats enabled skills as a system-prompt section", () => {
    const section = createSkillsPromptSection([
      { id: "enabled", name: "terraform", description: "Terraform conventions", enabled: true },
      { id: "disabled", name: "legacy", description: "Old guidance", enabled: false },
    ]);

    expect(section).toContain("<litellm_skills>");
    expect(section).toContain('<skill name="terraform">');
    expect(section).toContain("Terraform conventions");
    expect(section).not.toContain("Old guidance");
  });
});

describe("createSkillToolDefinitions", () => {
  it("creates Pi tools for listing, creating, and deleting LiteLLM skills", async () => {
    const definitions = createSkillToolDefinitions("https://litellm.example.com", async () => "sk-test");

    expect(definitions.map((definition) => definition.name)).toEqual([
      "litellm_skill_list",
      "litellm_skill_create",
      "litellm_skill_delete",
    ]);
  });

  it("executes the list tool with a fresh token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, [{ id: "skill-1", name: "terraform", description: "Terraform conventions" }]),
    );
    const getApiKey = vi.fn().mockResolvedValue("fresh-token");
    const [listTool] = createSkillToolDefinitions("https://litellm.example.com", getApiKey);
    type Params = Static<TSchema>;

    const result = await listTool?.execute("call-1", {} as Params, undefined, undefined, {} as never);

    expect(result?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("terraform") });
    expect(getApiKey).toHaveBeenCalledOnce();
  });
});
