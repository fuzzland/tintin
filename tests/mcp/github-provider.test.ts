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

test("GitHubMcpProvider builds docker stdio config", async () => {
  const provider = new GitHubMcpProvider("github");
  await provider.init(
    {
      enabled: true,
      type: "github",
      mode: "docker",
      token: "token",
      docker_image: "ghcr.io/github/github-mcp-server",
      docker_args: ["--pull", "always"],
      toolsets: ["repos", "issues"],
    },
    baseContext(),
  );

  const info = provider.getServerInfo();
  assert.equal(info.transport, "stdio");
  assert.equal(info.command, "docker");
  assert.ok(info.args?.includes("run"));
  assert.ok(info.args?.includes("ghcr.io/github/github-mcp-server"));
  assert.equal(info.env?.GITHUB_PERSONAL_ACCESS_TOKEN, "token");
  assert.equal(info.env?.GITHUB_TOOLSETS, "repos,issues");
});

test("GitHubMcpProvider builds remote http config", async () => {
  const provider = new GitHubMcpProvider("github");
  await provider.init(
    {
      enabled: true,
      type: "github",
      mode: "remote",
      token: "token",
      github_host: "https://github.example.com",
      toolsets: ["repos"],
    },
    baseContext(),
  );

  const info = provider.getServerInfo();
  assert.equal(info.transport, "sse");
  assert.equal(info.url, "https://api.githubcopilot.com/mcp/");
  assert.equal(info.headers?.Authorization, "Bearer token");
  assert.equal(info.headers?.["X-GitHub-Host"], "https://github.example.com");
  assert.equal(info.headers?.["X-GitHub-Toolsets"], "repos");
});

test("GitHubMcpProvider requires binary_path in binary mode", async () => {
  const provider = new GitHubMcpProvider("github");
  await assert.rejects(() =>
    provider.init(
      {
        enabled: true,
        type: "github",
        mode: "binary",
        token: "token",
      },
      baseContext(),
    ),
  );
});
