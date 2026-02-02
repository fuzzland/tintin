import test from "node:test";
import assert from "node:assert/strict";
import { McpRegistry } from "../../src/runtime/mcp/registry.js";
import type { McpConfig } from "../../src/runtime/mcp/config.js";
import { createLogger } from "../../src/runtime/log.js";

test("McpRegistry starts and stops stdio providers", async () => {
  const config: McpConfig = {
    global_timeout_sec: 60,
    log_level: "info",
    providers: {
      echo: {
        enabled: true,
        type: "stdio",
        command: "echo",
        args: ["hi"],
        env: {},
      },
    },
  };

  const logger = createLogger("error");
  const registry = new McpRegistry(logger);
  await registry.loadFromConfig(config, {
    logger,
    workspaceDir: process.cwd(),
    globalConfig: {},
  });

  const servers = await registry.startAll();
  const info = servers.get("echo");
  assert.ok(info);
  assert.equal(info?.transport, "stdio");
  assert.equal(info?.status, "running");

  await registry.stopAll();
  const stopped = registry.getServerInfo("echo");
  assert.ok(stopped);
  assert.equal(stopped?.status, "stopped");
});
