import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { loadConfig } from "../../src/runtime/config.js";

function baseConfig(extra: string) {
  return `
[bot]
name = "tintin"
host = "0.0.0.0"
port = 8787
data_dir = "./data"
log_level = "info"
message_verbosity = 2

[db]
url = "sqlite://:memory:"
echo = false

[security]
restrict_paths = false

[codex]
binary = "codex"
sessions_dir = "./.codex/sessions"
poll_interval_ms = 1000
max_catchup_lines = 200
timeout_seconds = 60
env = {}
full_auto = true
dangerously_bypass_approvals_and_sandbox = true
skip_git_repo_check = true

[[projects]]
id = "proj"
name = "proj"
path = "*"

${extra}
`;
}

test("loadConfig parses MCP providers with validation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tintin-config-"));
  const configPath = path.join(dir, "config.toml");
  await writeFile(
    configPath,
    baseConfig(`
[cloud]
secrets_key = "test-secrets-key"

[mcp]
global_timeout_sec = 45
log_level = "warn"

[mcp.providers.demo_stdio]
type = "stdio"
command = "echo"
args = ["hello"]
env = { "FOO" = "bar" }

[mcp.providers.demo_http]
type = "http"
url = "https://example.com/mcp"
headers = { "Authorization" = "Bearer token" }
bearer_token_env_var = "MCP_HTTP_TOKEN"

[mcp.providers.demo_playwright]
type = "playwright"
provider = "local"
timeout_ms = 45000
`),
    "utf8",
  );

  try {
    const config = await loadConfig(configPath);
    assert.ok(config.mcp);
    const mcp = config.mcp!;
    assert.equal(mcp.global_timeout_sec, 45);
    assert.equal(mcp.log_level, "warn");
    const stdio = mcp.providers.demo_stdio;
    assert.ok(stdio);
    if (stdio.type !== "stdio") throw new Error("Expected stdio provider");
    assert.deepEqual(stdio.args, ["hello"]);
    const http = mcp.providers.demo_http;
    assert.ok(http);
    if (http.type !== "http") throw new Error("Expected http provider");
    assert.equal(http.headers.Authorization, "Bearer token");
    assert.equal(http.bearer_token_env_var, "MCP_HTTP_TOKEN");
    const playwright = mcp.providers.demo_playwright;
    assert.ok(playwright);
    if (playwright.type !== "playwright") throw new Error("Expected playwright provider");
    assert.equal(playwright.startup_timeout_sec, 45);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects MCP provider without type", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tintin-config-"));
  const configPath = path.join(dir, "config.toml");
  await writeFile(
    configPath,
    baseConfig(`
[cloud]
secrets_key = "test-secrets-key"

[mcp]
global_timeout_sec = 60
log_level = "info"

[mcp.providers.bad]
command = "echo"
`),
    "utf8",
  );

  try {
    await assert.rejects(() => loadConfig(configPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig allows notion provider without explicit type", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tintin-config-"));
  const configPath = path.join(dir, "config.toml");
  await writeFile(
    configPath,
    baseConfig(`
[cloud]
secrets_key = "test-secrets-key"

[mcp]
global_timeout_sec = 60
log_level = "info"

[mcp.providers.notion]
enabled = true
`),
    "utf8",
  );

  try {
    const config = await loadConfig(configPath);
    const provider = config.mcp?.providers.notion;
    assert.ok(provider);
    if (provider.type !== "notion") throw new Error("Expected notion provider");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects notion provider with wrong name", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tintin-config-"));
  const configPath = path.join(dir, "config.toml");
  await writeFile(
    configPath,
    baseConfig(`
[cloud]
secrets_key = "test-secrets-key"

[mcp]
global_timeout_sec = 60
log_level = "info"

[mcp.providers.notion_alt]
type = "notion"
`),
    "utf8",
  );

  try {
    await assert.rejects(() => loadConfig(configPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
