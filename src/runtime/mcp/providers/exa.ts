const EXA_MCP_BASE_URL = "https://mcp.exa.ai/mcp";

export const EXA_MCP_TOOLS = [
  "web_search_exa",
  "web_search_advanced_exa",
  "get_code_context_exa",
  "crawling_exa",
  "company_research_exa",
  "people_search_exa",
  "deep_researcher_start",
  "deep_researcher_check",
] as const;

export function buildExaMcpUrl(apiKey: string): string {
  const params = new URLSearchParams();
  params.set("exaApiKey", apiKey);
  params.set("tools", EXA_MCP_TOOLS.join(","));
  return `${EXA_MCP_BASE_URL}?${params.toString()}`;
}
