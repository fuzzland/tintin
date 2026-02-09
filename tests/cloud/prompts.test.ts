import { describe, it } from "node:test";
import assert from "node:assert";
import { loadAllPrompts, loadRootAgentsMd, buildAgentsMdContent } from "../../src/runtime/cloud/prompts.js";

describe("prompts", () => {
  describe("loadRootAgentsMd", () => {
    it("should load AGENTS.md from root", async () => {
      const content = await loadRootAgentsMd();
      // Should contain some expected content from AGENTS.md
      assert.ok(content.includes("Tintin Developer Guide"));
    });
  });

  describe("loadAllPrompts", () => {
    it("should load prompts from prompts/ directory", async () => {
      const prompts = await loadAllPrompts();
      // Should at least have INIT_REGISTER_DEPLOY.md
      assert.ok(prompts.length > 0);
      const deployPrompt = prompts.find((p) => p.filename === "INIT_REGISTER_DEPLOY.md");
      assert.ok(deployPrompt);
      assert.ok(deployPrompt.content.includes("Code / Site / Deploy"));
    });

    it("should return prompts sorted alphabetically", async () => {
      const prompts = await loadAllPrompts();
      const filenames = prompts.map((p) => p.filename);
      // Check sorted
      const sorted = [...filenames].sort();
      assert.deepStrictEqual(filenames, sorted);
    });
  });

  describe("buildAgentsMdContent", () => {
    it("should include AGENTS.md for English", async () => {
      const content = await buildAgentsMdContent("en");
      assert.ok(content.includes("Tintin Developer Guide"));
    });

    it("should include prompts/*.md content", async () => {
      const content = await buildAgentsMdContent("en");
      assert.ok(content.includes("Code / Site / Deploy"));
    });

    it("should append Chinese locale directive for zh", async () => {
      const content = await buildAgentsMdContent("zh");
      assert.ok(content.includes("你必须用中文回答"));
    });

    it("should not append locale directive for English", async () => {
      const content = await buildAgentsMdContent("en");
      assert.ok(content.includes("You must respond in English"));
      assert.ok(!content.includes("你必须用中文回答"));
    });
  });
});
