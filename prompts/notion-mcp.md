# Notion MCP Usage Guide

When using Notion MCP tools, follow these patterns for efficient execution.

## Available Tools

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `notion-search` | Search workspace & connected apps | Finding pages, docs, or content by keywords |
| `notion-fetch` | Get page/database content by URL | When you have a specific Notion URL |
| `notion-create-pages` | Create new pages | Adding new content, notes, or entries |
| `notion-update-page` | Modify page properties/content | Changing status, adding sections |
| `notion-move-pages` | Relocate pages | Reorganizing content |
| `notion-duplicate-page` | Copy a page | Creating from templates |
| `notion-create-database` | Create new database | Setting up structured data tracking |
| `notion-update-data-source` | Modify database schema | Adding/changing properties |
| `notion-query-data-sources` | Query across databases | Cross-database analysis (Enterprise) |
| `notion-query-database-view` | Query using saved views | Using pre-defined filters (Business+) |
| `notion-create-comment` | Add page comment | Leaving feedback or notes |
| `notion-get-comments` | List page comments | Reading discussions |
| `notion-get-teams` | List teamspaces | Finding team IDs |
| `notion-get-users` | List workspace users | Looking up user details |
| `notion-get-user` | Get user by ID | Specific user lookup |
| `notion-get-self` | Get bot/workspace info | Checking connection status |

## Efficient Patterns

### Listing Recent Pages
`notion-search` requires a non-empty query. If the user asks for “recent pages” without keywords, ask them for a keyword, page URL, or database to target. Then search with that keyword:
```
notion-search with query="project status"
```

### Finding Specific Content
Use `notion-search` with targeted keywords:
```
notion-search with query="project status" 
```

### Reading Page Content
Use `notion-fetch` with the page URL:
```
notion-fetch with url="https://notion.so/page-id"
```

### Creating Content
Use `notion-create-pages` - parent is optional (creates private page if omitted):
```
notion-create-pages with title and content
```

## Rate Limits

- General: 180 requests/minute (3/sec average)
- Search: 30 requests/minute

Avoid parallel searches. Sequential operations are preferred.

## Common Mistakes to Avoid

1. Do NOT call `list_mcp_resources` or `list_mcp_resource_templates` - Notion MCP exposes tools only
2. Do NOT make excessive parallel requests - respect rate limits
3. Do NOT assume database IDs - use search to find them first
4. When listing pages, use `notion-search` not `notion-fetch`
