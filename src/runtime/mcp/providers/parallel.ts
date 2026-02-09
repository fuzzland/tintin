const PARALLEL_SEARCH_MCP_URL = "https://search-mcp.parallel.ai/mcp";
const PARALLEL_TASK_MCP_URL = "https://task-mcp.parallel.ai/mcp";

export const PARALLEL_SEARCH_TOOLS = ["web_search", "web_fetch"] as const;

export const PARALLEL_TASK_TOOLS = ["Create Deep Research Task", "Create Task Group", "Get Result"] as const;

export function buildParallelAuthHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

export function getParallelSearchMcpUrl(): string {
  return PARALLEL_SEARCH_MCP_URL;
}

export function getParallelTaskMcpUrl(): string {
  return PARALLEL_TASK_MCP_URL;
}
