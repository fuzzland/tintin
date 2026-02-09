import test from "node:test";
import assert from "node:assert/strict";
import { getAgentAdapter } from "../../src/runtime/agents.js";
import type { McpServerInfo } from "../../src/runtime/mcp/types.js";

test("codex MCP args include bearer_token_env_var for parallel servers", () => {
  const servers = new Map<string, McpServerInfo>([
    [
      "parallel_search",
      {
        id: "parallel_search",
        transport: "http",
        url: "https://search-mcp.parallel.ai/mcp",
        headers: { Authorization: "Bearer test" },
        bearerTokenEnvVar: "TINTIN_MCP_BEARER_PARALLEL_SEARCH",
        bearerToken: "test",
        status: "running",
      },
    ],
    [
      "parallel_task",
      {
        id: "parallel_task",
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

  assert.match(joined, /mcp_servers\.parallel_search\.bearer_token_env_var/);
  assert.match(joined, /mcp_servers\.parallel_task\.bearer_token_env_var/);
  assert.doesNotMatch(joined, /mcp_servers\."parallel_search"\./);
  assert.doesNotMatch(joined, /mcp_servers\."parallel_task"\./);
  assert.doesNotMatch(joined, /Authorization/);
});

test("codex MCP args keep unquoted keys for simple server names", () => {
  const servers = new Map<string, McpServerInfo>([
    [
      "exa",
      {
        id: "exa",
        transport: "http",
        url: "https://mcp.exa.ai/mcp",
        status: "running",
      },
    ],
  ]);

  const adapter = getAgentAdapter("codex");
  const args = adapter.buildMcpCliArgs({ servers, globalTimeout: 60 });
  const joined = args.join(" ");

  assert.match(joined, /mcp_servers\.exa\.url=/);
  assert.doesNotMatch(joined, /mcp_servers\."exa"\.url=/);
});
