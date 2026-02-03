import test from "node:test";
import assert from "node:assert/strict";
import { GitHubMcpProvider } from "../../src/runtime/mcp/providers/github.js";
import { createLogger } from "../../src/runtime/log.js";

function baseContext() {
  const logger = createLogger("error");
  return {
    logger,
    workspaceDir: "/tmp",
    globalConfig: {},
  };
}

test("GitHubMcpProvider exposes remote config metadata", async () => {
  const provider = new GitHubMcpProvider("github");
  await provider.init(
    {
      enabled: true,
      type: "github",
      github_host: "https://github.example.com",
      toolsets: ["repos"],
    },
    baseContext(),
  );

  const info = provider.getServerInfo();
  assert.equal(info.transport, "http");
  assert.equal(info.url, "https://api.githubcopilot.com/mcp/");
  assert.equal(info.headers?.["X-GitHub-Host"], "https://github.example.com");
  assert.equal(info.headers?.["X-MCP-Toolsets"], "repos");
});

test("GitHubMcpProvider start rejects per-user token requirement", async () => {
  const provider = new GitHubMcpProvider("github");
  await provider.init(
    {
      enabled: true,
      type: "github",
    },
    baseContext(),
  );
  await assert.rejects(() => provider.start());
});
