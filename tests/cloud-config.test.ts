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

test("loadConfig applies Modal defaults when provider is modal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tintin-config-"));
  const configPath = path.join(dir, "config.toml");
  await writeFile(
    configPath,
    baseConfig(`
[cloud]
enabled = true
provider = "modal"
public_base_url = "https://cloud.example.com"
`),
    "utf8",
  );

  try {
    const config = await loadConfig(configPath);
    assert.equal(config.cloud?.provider, "modal");
    const modal = config.cloud?.modal;
    assert.ok(modal);
    assert.equal(modal?.app_name, "tintin-cloud");
    assert.equal(modal?.image, "debian:12");
    assert.equal(modal?.workspace_root, "/workspace/tintin");
    assert.equal(modal?.command_timeout_ms, 60000);
    assert.equal(modal?.request_timeout_ms, 60000);
    assert.equal(modal?.timeout_ms, 300000);
    assert.equal(modal?.idle_timeout_ms, 300000);
    assert.equal(modal?.block_network, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig preserves explicit Modal settings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tintin-config-"));
  const configPath = path.join(dir, "config.toml");
  await writeFile(
    configPath,
    baseConfig(`
[cloud]
enabled = true
provider = "modal"
public_base_url = "https://cloud.example.com"

[cloud.modal]
token_id = "modal-id"
token_secret = "modal-secret"
environment = "dev"
endpoint = "https://modal.example.com"
app_name = "tintin-dev"
image = "ubuntu:22.04"
image_id = "im-123"
timeout_ms = 120000
idle_timeout_ms = 90000
request_timeout_ms = 15000
command_timeout_ms = 45000
block_network = true
cidr_allowlist = ["10.0.0.0/8"]
workspace_root = "/workspace"
codex_binary = "codex-custom"
claude_binary = "claude-custom"
`),
    "utf8",
  );

  try {
    const config = await loadConfig(configPath);
    const modal = config.cloud?.modal;
    assert.ok(modal);
    assert.equal(modal?.token_id, "modal-id");
    assert.equal(modal?.token_secret, "modal-secret");
    assert.equal(modal?.environment, "dev");
    assert.equal(modal?.endpoint, "https://modal.example.com");
    assert.equal(modal?.app_name, "tintin-dev");
    assert.equal(modal?.image, "ubuntu:22.04");
    assert.equal(modal?.image_id, "im-123");
    assert.equal(modal?.timeout_ms, 120000);
    assert.equal(modal?.idle_timeout_ms, 90000);
    assert.equal(modal?.request_timeout_ms, 15000);
    assert.equal(modal?.command_timeout_ms, 45000);
    assert.equal(modal?.block_network, true);
    assert.deepEqual(modal?.cidr_allowlist, ["10.0.0.0/8"]);
    assert.equal(modal?.workspace_root, "/workspace");
    assert.equal(modal?.codex_binary, "codex-custom");
    assert.equal(modal?.claude_binary, "claude-custom");
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
provider = "modal"

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
webhook_path = "/github/webhook"
webhook_secret = "secret"
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
webhook_path = "/github/webhook"
webhook_secret = "secret"
`),
    "utf8",
  );

  try {
    await assert.rejects(() => loadConfig(configPath), /base64/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
