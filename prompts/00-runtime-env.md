# Runtime Environment Notes

Playwright and its browser binaries are preinstalled in the container.

- Do NOT run `npm install playwright`, `npx playwright install`, or any runtime dependency installation.
- Use the preinstalled global Playwright via Node (e.g., `node -e "require('playwright')"`).
- Browsers are located at `/opt/playwright-browsers` and `PLAYWRIGHT_BROWSERS_PATH` is set.

If a task requires a browser, assume Playwright is ready and avoid altering the repo or creating `node_modules`. 

When reporting file paths in responses, use paths relative to the current working directory (cwd) and never expose absolute container paths like `/workspace/...`.
