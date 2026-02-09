import test from "node:test";
import assert from "node:assert/strict";
import type { McpConfig } from "../../src/runtime/mcp/config.js";
import { resolveMcpProviderActivation } from "../../src/runtime/mcp/activation.js";

function buildConfig(): McpConfig {
  return {
    global_timeout_sec: 60,
    log_level: "info",
    providers: {
      github: {
        enabled: true,
        type: "github",
      },
      notion: {
        enabled: true,
        type: "notion",
      },
      exa: {
        enabled: true,
        type: "exa",
        api_key: "test-exa",
      },
      parallel: {
        enabled: true,
        type: "parallel",
        api_key: "test-parallel",
        search_enabled: true,
        task_enabled: true,
      },
    },
  };
}

test("resolveMcpProviderActivation keeps non-user-auth providers active", () => {
  const plan = resolveMcpProviderActivation(buildConfig(), "search MCP docs and summarize latest updates");
  assert.equal(plan.activeProviderNames.has("exa"), true);
  assert.equal(plan.activeProviderNames.has("parallel"), true);
});

test("resolveMcpProviderActivation defers github without github intent", () => {
  const plan = resolveMcpProviderActivation(buildConfig(), "use Parallel MCP web_search for MCP overview");
  assert.equal(plan.activeProviderNames.has("github"), false);
  assert.equal(plan.deferredProviderNames.has("github"), true);
});

test("resolveMcpProviderActivation activates github when prompt targets github", () => {
  const plan = resolveMcpProviderActivation(
    buildConfig(),
    "Use GitHub MCP to list open issues from github.com/openai/openai-node",
  );
  assert.equal(plan.activeProviderNames.has("github"), true);
  assert.equal(plan.deferredProviderNames.has("github"), false);
});

test("resolveMcpProviderActivation activates notion when prompt targets notion", () => {
  const plan = resolveMcpProviderActivation(buildConfig(), "use notion mcp to search workspace docs");
  assert.equal(plan.activeProviderNames.has("notion"), true);
  assert.equal(plan.deferredProviderNames.has("notion"), false);
});

test("resolveMcpProviderActivation keeps github deferred for generic mention", () => {
  const plan = resolveMcpProviderActivation(
    buildConfig(),
    "Compare GitHub and GitLab ecosystem trends for developer productivity",
  );
  assert.equal(plan.activeProviderNames.has("github"), false);
  assert.equal(plan.deferredProviderNames.has("github"), true);
});

test("resolveMcpProviderActivation keeps notion deferred for generic mention", () => {
  const plan = resolveMcpProviderActivation(
    buildConfig(),
    "Compare Notion with Confluence for team documentation strategy",
  );
  assert.equal(plan.activeProviderNames.has("notion"), false);
  assert.equal(plan.deferredProviderNames.has("notion"), true);
});

test("resolveMcpProviderActivation activates github with action + target", () => {
  const plan = resolveMcpProviderActivation(
    buildConfig(),
    "Please list open issues from github.com/fuzzland/tintin and summarize blockers",
  );
  assert.equal(plan.activeProviderNames.has("github"), true);
  assert.equal(plan.deferredProviderNames.has("github"), false);
});

test("resolveMcpProviderActivation activates github with Chinese action + target", () => {
  const plan = resolveMcpProviderActivation(
    buildConfig(),
    "请在 GitHub 仓库 fuzzland/tintin 中查看最近 5 个 PR 并总结",
  );
  assert.equal(plan.activeProviderNames.has("github"), true);
});

test("resolveMcpProviderActivation activates notion with URL + action", () => {
  const plan = resolveMcpProviderActivation(
    buildConfig(),
    "Read this Notion page and summarize action items: https://www.notion.so/team/weekly-review-123",
  );
  assert.equal(plan.activeProviderNames.has("notion"), true);
  assert.equal(plan.deferredProviderNames.has("notion"), false);
});

test("resolveMcpProviderActivation activates notion with Chinese action + target", () => {
  const plan = resolveMcpProviderActivation(
    buildConfig(),
    "在 Notion 工作区中搜索 API 设计文档并提取决策结论",
  );
  assert.equal(plan.activeProviderNames.has("notion"), true);
});

test("resolveMcpProviderActivation activates github without github keyword when owner/repo context is clear", () => {
  const plan = resolveMcpProviderActivation(
    buildConfig(),
    "List open issues in fuzzland/tintin and summarize root causes",
  );
  assert.equal(plan.activeProviderNames.has("github"), true);
});

test("resolveMcpProviderActivation activates github without github keyword when PR reference exists", () => {
  const plan = resolveMcpProviderActivation(buildConfig(), "Review PR#128 and summarize requested changes");
  assert.equal(plan.activeProviderNames.has("github"), true);
});

test("resolveMcpProviderActivation activates notion without notion keyword for strong notion entities", () => {
  const plan = resolveMcpProviderActivation(
    buildConfig(),
    "Search teamspace pages and update database view status summary",
  );
  assert.equal(plan.activeProviderNames.has("notion"), true);
});
