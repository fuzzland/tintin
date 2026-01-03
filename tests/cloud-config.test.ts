import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { loadConfig } from "../src/runtime/config.js";

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

test("loadConfig applies E2B defaults when provider is e2b", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tintin-config-"));
  const configPath = path.join(dir, "config.toml");
  await writeFile(
    configPath,
    baseConfig(`
[cloud]
enabled = true
provider = "e2b"
public_base_url = "https://cloud.example.com"
`),
    "utf8",
  );

  try {
    const config = await loadConfig(configPath);
    assert.equal(config.cloud?.provider, "e2b");
    const e2b = config.cloud?.e2b;
    assert.ok(e2b);
    assert.equal(e2b?.template_id, "tintin-playwright");
    assert.equal(e2b?.workspace_root, "/home/user/tintin");
    assert.equal(e2b?.command_timeout_ms, 60000);
    assert.equal(e2b?.request_timeout_ms, 60000);
    assert.equal(e2b?.timeout_ms, 300000);
    assert.equal(e2b?.allow_internet_access, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig preserves explicit E2B settings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tintin-config-"));
  const configPath = path.join(dir, "config.toml");
  await writeFile(
    configPath,
    baseConfig(`
[cloud]
enabled = true
provider = "e2b"
public_base_url = "https://cloud.example.com"

[cloud.e2b]
api_key = "test-key"
template_id = "tmpl-123"
domain = "e2b.dev"
timeout_ms = 120000
request_timeout_ms = 15000
command_timeout_ms = 45000
secure = false
allow_internet_access = false
workspace_root = "/workspace"
codex_binary = "codex-custom"
claude_binary = "claude-custom"
`),
    "utf8",
  );

  try {
    const config = await loadConfig(configPath);
    const e2b = config.cloud?.e2b;
    assert.ok(e2b);
    assert.equal(e2b?.api_key, "test-key");
    assert.equal(e2b?.template_id, "tmpl-123");
    assert.equal(e2b?.domain, "e2b.dev");
    assert.equal(e2b?.timeout_ms, 120000);
    assert.equal(e2b?.request_timeout_ms, 15000);
    assert.equal(e2b?.command_timeout_ms, 45000);
    assert.equal(e2b?.secure, false);
    assert.equal(e2b?.allow_internet_access, false);
    assert.equal(e2b?.workspace_root, "/workspace");
    assert.equal(e2b?.codex_binary, "codex-custom");
    assert.equal(e2b?.claude_binary, "claude-custom");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects proxy without public base url", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tintin-config-"));
  const configPath = path.join(dir, "config.toml");
  await writeFile(
    configPath,
    baseConfig(`
[cloud]
enabled = true
provider = "e2b"

[cloud.proxy]
enabled = true
shared_secret = "secret"
`),
    "utf8",
  );

  try {
    await assert.rejects(() => loadConfig(configPath), /public_base_url/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig decodes base64 GitHub App private key", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tintin-config-"));
  const configPath = path.join(dir, "config.toml");
  const pem = "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----\n";
  const pemB64 = Buffer.from(pem, "utf8").toString("base64");
  await writeFile(
    configPath,
    baseConfig(`
[cloud]
enabled = true
public_base_url = "https://cloud.example.com"

[cloud.github_app]
app_id = "123"
app_slug = "tintin"
private_key = "${pemB64}"
`),
    "utf8",
  );

  try {
    const config = await loadConfig(configPath);
    const key = config.cloud?.github_app?.private_key ?? "";
    assert.ok(key.includes("BEGIN PRIVATE KEY"));
    assert.equal(key, pem);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects raw GitHub App private key", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tintin-config-"));
  const configPath = path.join(dir, "config.toml");
  const pem = "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----\n";
  const pemInline = pem.replace(/\n/g, "\\n");
  await writeFile(
    configPath,
    baseConfig(`
[cloud]
enabled = true
public_base_url = "https://cloud.example.com"

[cloud.github_app]
app_id = "123"
app_slug = "tintin"
private_key = "${pemInline}"
`),
    "utf8",
  );

  try {
    await assert.rejects(() => loadConfig(configPath), /base64/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
