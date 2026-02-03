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

test("loadConfig parses GitHub MCP docker config", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tintin-config-"));
  const configPath = path.join(dir, "config.toml");
  process.env.GITHUB_TOKEN = "test-token";
  await writeFile(
    configPath,
    baseConfig(`
[cloud]
secrets_key = "test-secrets-key"

[mcp]
global_timeout_sec = 60
log_level = "info"

[mcp.providers.github]
type = "github"
mode = "docker"
token = "env:GITHUB_TOKEN"
`),
    "utf8",
  );

  try {
    const config = await loadConfig(configPath);
    const provider = config.mcp?.providers.github;
    assert.ok(provider);
    if (provider.type !== "github") throw new Error("Expected github provider");
    assert.equal(provider.mode, "docker");
    assert.equal(provider.docker_image, "ghcr.io/github/github-mcp-server");
    assert.deepEqual(provider.docker_args, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
    delete process.env.GITHUB_TOKEN;
  }
});

test("loadConfig parses GitHub MCP binary config", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tintin-config-"));
  const configPath = path.join(dir, "config.toml");
  process.env.GITHUB_TOKEN = "test-token";
  await writeFile(
    configPath,
    baseConfig(`
[cloud]
secrets_key = "test-secrets-key"

[mcp]
global_timeout_sec = 60
log_level = "info"

[mcp.providers.github]
type = "github"
mode = "binary"
token = "env:GITHUB_TOKEN"
binary_path = "/usr/local/bin/github-mcp-server"
`),
    "utf8",
  );

  try {
    const config = await loadConfig(configPath);
    const provider = config.mcp?.providers.github;
    assert.ok(provider);
    if (provider.type !== "github") throw new Error("Expected github provider");
    assert.equal(provider.mode, "binary");
    assert.equal(provider.binary_path, "/usr/local/bin/github-mcp-server");
    assert.deepEqual(provider.binary_args, ["stdio"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    delete process.env.GITHUB_TOKEN;
  }
});

test("loadConfig parses GitHub MCP remote config", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tintin-config-"));
  const configPath = path.join(dir, "config.toml");
  process.env.GITHUB_TOKEN = "test-token";
  await writeFile(
    configPath,
    baseConfig(`
[cloud]
secrets_key = "test-secrets-key"

[mcp]
global_timeout_sec = 60
log_level = "info"

[mcp.providers.github]
type = "github"
mode = "remote"
token = "env:GITHUB_TOKEN"
`),
    "utf8",
  );

  try {
    const config = await loadConfig(configPath);
    const provider = config.mcp?.providers.github;
    assert.ok(provider);
    if (provider.type !== "github") throw new Error("Expected github provider");
    assert.equal(provider.mode, "remote");
  } finally {
    await rm(dir, { recursive: true, force: true });
    delete process.env.GITHUB_TOKEN;
  }
});

test("loadConfig rejects GitHub MCP token without env prefix", async () => {
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

[mcp.providers.github]
type = "github"
mode = "remote"
token = "ghp_plaintext"
`),
    "utf8",
  );

  try {
    await assert.rejects(() => loadConfig(configPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
