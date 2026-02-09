import test from "node:test";
import assert from "node:assert/strict";
import { getAgentAdapter } from "../../src/runtime/agents.js";
import type { McpServerInfo } from "../../src/runtime/mcp/types.js";

test("codex MCP args include bearer_token_env_var for parallel servers", () => {
  const servers = new Map<string, McpServerInfo>([
    [
      "parallel-search",
      {
        id: "parallel-search",
        transport: "http",
        url: "https://search-mcp.parallel.ai/mcp",
        headers: { Authorization: "Bearer test" },
        bearerTokenEnvVar: "TINTIN_MCP_BEARER_PARALLEL_SEARCH",
        bearerToken: "test",
        status: "running",
      },
    ],
    [
      "parallel-task",
      {
        id: "parallel-task",
        transport: "http",
        url: "https://task-mcp.parallel.ai/mcp",
        headers: { Authorization: "Bearer test" },
        bearerTokenEnvVar: "TINTIN_MCP_BEARER_PARALLEL_TASK",
        bearerToken: "test",
        status: "running",
      },
    ],
  ]);

  const adapter = getAgentAdapter("codex");
  const args = adapter.buildMcpCliArgs({ servers, globalTimeout: 60 });
  const joined = args.join(" ");

  assert.match(joined, /mcp_servers\.parallel-search\.bearer_token_env_var/);
  assert.match(joined, /mcp_servers\.parallel-task\.bearer_token_env_var/);
  assert.doesNotMatch(joined, /Authorization/);
});

