# Exa MCP Usage Guide

When using Exa MCP tools, follow these patterns for efficient web search and research.

## Available Tools (Enabled in Tintin)

### Core Tools

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `web_search_exa` | Search the web for any topic | General web searches, finding articles, news |
| `get_code_context_exa` | Find code examples and documentation | Looking up API usage, code patterns, Stack Overflow |
| `company_research_exa` | Research companies | Business info, news, company profiles |

### Advanced Tools

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `web_search_advanced_exa` | Advanced search with filters | Need date ranges, domain filters, content options |
| `crawling_exa` | Get full webpage content | Have a specific URL, need complete page text |
| `people_search_exa` | Find people and profiles | Looking up professionals, LinkedIn-style search |
| `deep_researcher_start` | Start AI research agent | Complex research requiring multiple sources |
| `deep_researcher_check` | Check research status | Get results from deep research task |

Tintin enables all tools listed above by default (no config needed).

## Efficient Patterns

### Web Search
```
web_search_exa with query="latest developments in AI agents 2024"
```

### Code Search
```
get_code_context_exa with query="Python OAuth 2.0 implementation example"
```

### Company Research
```
company_research_exa with query="Stripe payment processing"
```

### Deep Research
```
1. deep_researcher_start with query="comprehensive analysis of quantum computing startups"
2. Wait for task_id
3. deep_researcher_check with task_id to get results
```

## Best Practices

1. Be specific - more specific queries yield better results
2. Use code search for programming - `get_code_context_exa` searches GitHub, Stack Overflow, and docs
3. Company research for business - `company_research_exa` is optimized for business intelligence
4. Deep research for complex topics - use when you need comprehensive, multi-source analysis

## Rate Limits

- Free plan has generous limits
- Tintin uses a per-user Exa key (if set via `/mcp exa key set <key>`), otherwise it falls back to `mcp.providers.exa.api_key`.
- If you hit rate limits (429 errors) or auth failures, ask the user to set their own Exa API key.

## Common Mistakes to Avoid

1. Do NOT use `web_search_exa` for code - use `get_code_context_exa` instead
2. Do NOT make excessive parallel requests - sequential is preferred
3. Do NOT use `crawling_exa` without a specific URL - use search first to find URLs
