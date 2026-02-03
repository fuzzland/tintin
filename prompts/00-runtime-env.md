# Runtime Environment Notes

Playwright and its browser binaries are preinstalled in the container.

- Do NOT run `npm install playwright`, `npx playwright install`, or any runtime dependency installation.
- Use the preinstalled global Playwright via Node (e.g., `node -e "require('playwright')"`).
- Browsers are located at `/opt/playwright-browsers` and `PLAYWRIGHT_BROWSERS_PATH` is set.

If a task requires a browser, assume Playwright is ready and avoid altering the repo or creating `node_modules`. 

When reporting file paths in responses, use paths relative to the current working directory (cwd) and never expose absolute container paths like `/workspace/...`.

## MCP Notes

- Some MCP servers (e.g., GitHub MCP) expose **tools** but may return **no resources/templates**.
- Do **not** treat empty `list_mcp_resources` or `list_mcp_resource_templates` as MCP being unavailable.
- If MCP is configured, proceed with the requested task; only report MCP unavailable if a direct tool call fails.
