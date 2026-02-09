# Parallel.ai MCP Usage Guide

When using Parallel.ai MCP tools, follow these patterns for efficient web search and deep research.

## Available Tools (Enabled in Tintin)

### Search MCP Tools

| Tool         | Purpose                            | When to Use                                         |
| ------------ | ---------------------------------- | --------------------------------------------------- |
| `web_search` | Search the web for information     | General web searches, finding articles, news, facts |
| `web_fetch`  | Extract content from specific URLs | Have a URL, need full page content to analyze       |

### Task MCP Tools

| Tool                        | Purpose                           | When to Use                                    |
| --------------------------- | --------------------------------- | ---------------------------------------------- |
| `Create Deep Research Task` | Start comprehensive research      | Complex topics requiring multi-source analysis |
| `Create Task Group`         | Enrich multiple items in parallel | Batch processing, data enrichment workflows    |
| `Get Result`                | Retrieve task/group results       | Check status and get results of async tasks    |

Tintin enables all tools listed above by default (no config needed).

## Efficient Patterns

### Web Search

```
web_search with query="latest developments in AI agents 2025"
```

### Content Extraction

```
web_fetch with url="https://example.com/article"
```

### Deep Research (async)

```
1. Create Deep Research Task with query="comprehensive analysis of quantum computing startups"
2. Note the task ID returned
3. Get Result with task_id to check status and retrieve results
```

### Batch Enrichment

```
1. Create Task Group with items and processing instructions
2. Get Result with group_id to retrieve enriched data
```

## Best Practices

1. **Use web_search for quick lookups** - fast, concise results optimized for agents
2. **Use web_fetch for specific URLs** - when you already know the URL and need full content
3. **Use Deep Research for complex topics** - when you need comprehensive, multi-source analysis
4. **Use Task Groups for batch work** - enriching datasets, parallel processing multiple items
5. **Follow up on async tasks** - Deep Research and Task Groups are async; use Get Result to check

## Rate Limits

- API key provides access to both Search and Task MCP
- Tintin uses a per-user Parallel key (if set via `/mcp parallel key set <key>`), otherwise falls back to `mcp.providers.parallel.api_key`
- If you hit rate limits (429 errors) or auth failures (402 insufficient credits), ask the user to set their own API key

## Common Mistakes to Avoid

1. Do NOT use `web_fetch` without a specific URL - use `web_search` first to find URLs
2. Do NOT forget to follow up on Deep Research tasks - they are async and need a Get Result call
3. Do NOT use Task MCP with small models - it requires strong reasoning (GPT-5, Claude Sonnet 4.5+)
4. Do NOT overload context with too many parallel tasks - be mindful of context window limits
