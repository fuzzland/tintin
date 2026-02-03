import test from "node:test";
import assert from "node:assert/strict";
import type { McpConfig, PlaywrightMcpProviderConfig } from "../../src/runtime/mcp/config.js";
import { buildMcpBootstrapConfig } from "../../src/runtime/mcp/bootstrap.js";

function basePlaywright(overrides?: Partial<PlaywrightMcpProviderConfig>): PlaywrightMcpProviderConfig {
  return {
    enabled: true,
    type: "playwright",
    provider: "local",
    browserbase: null,
    hyperbrowser: null,
    package: "@playwright/mcp@latest",
    browser: "chrome",
    host: "127.0.0.1",
    port_start: 11001,
    port_end: 11100,
    snapshot_mode: "full",
    image_responses: "allow",
    headless: true,
    user_data_dir: "/tmp/profile",
    output_dir: "/tmp/out",
    executable_path: undefined,
    timeout_ms: 20000,
    user_agent: "ua",
    viewport_size: "1366x768",
    startup_timeout_sec: 30,
    ...overrides,
  };
}

test("buildMcpBootstrapConfig selects only local Playwright providers", () => {
  const config: McpConfig = {
    global_timeout_sec: 60,
    log_level: "info",
    providers: {
      local: basePlaywright(),
      browserbase: basePlaywright({
        provider: "browserbase",
        browserbase: {
          api_key: "key",
          project_id: "proj",
          keep_alive: false,
        },
      }),
      stdio: {
        enabled: true,
        type: "stdio",
        command: "echo",
        args: [],
        env: {},
      },
    },
  };

  const bootstrap = buildMcpBootstrapConfig(config);
  assert.ok(bootstrap);
  assert.deepEqual(Object.keys(bootstrap!.providers), ["local"]);
  const local = bootstrap!.providers.local;
  assert.ok(local);
  assert.equal(local.type, "playwright");
});

test("buildMcpBootstrapConfig returns null when no local providers", () => {
  const config: McpConfig = {
    global_timeout_sec: 60,
    log_level: "info",
    providers: {
      browserbase: basePlaywright({
        provider: "browserbase",
        browserbase: {
          api_key: "key",
          project_id: "proj",
          keep_alive: false,
        },
      }),
    },
  };

  const bootstrap = buildMcpBootstrapConfig(config);
  assert.equal(bootstrap, null);
});

test("buildMcpBootstrapConfig ignores GitHub providers", () => {
  const config: McpConfig = {
    global_timeout_sec: 60,
    log_level: "info",
    providers: {
      github: {
        enabled: true,
        type: "github",
      },
    },
  };

  const bootstrap = buildMcpBootstrapConfig(config);
  assert.equal(bootstrap, null);
});
