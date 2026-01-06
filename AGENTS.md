# Tintin Developer Guide

## What it does

- Chat entrypoint for Codex / Claude Code via Telegram or Slack; can drive Playwright MCP / Browserbase / Hyperbrowser.
- Runs locally or in cloud mode (Local provider or Modal sandboxes); ships a lightweight Cloud UI and `tinc` CLI for runs/diffs/screenshots.

## Architecture

```
Telegram/Slack/CLI/UI
   │
   ▼
controller2 + sessionManager
   ├─ agents: codex / claudeCode
   ├─ browser: playwrightMcp / browserbase / hyperbrowser
   └─ cloud: cloud/manager -> localProvider | modalProvider
   ▼
DB (Kysely) + JSONL/diff/screenshots/S3
```

## Layout

- `tintin.ts`: CLI entrypoint (`tintin`).
- `src/main.ts`: daemon entrypoint (load config, init DB, migrate, start service).
- `src/runtime/`: core (config, db, log, service, controller2, sessionManager, agents, messaging, streamer, security/redact, playwrightMcp).
- `src/runtime/cloud/`: cloud manager, providers (local/modal), GitHub App/OAuth/repos, proxy, secrets, s3, UI tokens/artifacts, browser adapters.
- `setup_docs/`: Slack/Telegram setup.

## Key commands

```bash
npm ci
npm run typecheck
npm run build
npm start                        # node dist/src/main.js
npm run migrate
CONFIG_PATH=./config.toml node dist/tintin.js start
```

## Config essentials

- Use `config.example.toml` as template; keep local `config.toml` out of git.
- Important sections: `[bot]`, `[cloud]`, `[cloud.modal]`, `[playwright_mcp]`, `[security]`, `[cloud.ui]`, `[cloud.proxy]`.
- Store secrets as `env:VAR`; never commit real tokens or data dirs (`data/`, `.codex/`).

## Coding practices

- TypeScript + ESM, 2-space indent, double quotes, semicolons; avoid `any`, use `import type`.
- Log with injected `logger` (`debug/info/warn/error`); include context and timing for cloud paths.
- Prefer POSIX paths; handle timeouts/concurrency carefully in cloud flows.
- For migrations: add `src/runtime/migrations/000x_description.ts`, update README/config example if config changes.

## Testing & verification

- Minimal by default: run `npm run typecheck`; smoke test daemon plus a sample run/status (local or cloud).
- Cloud Modal issues: use trace logs (`log_level=info`) to see `[cloud][modal][trace]` stages; first sandbox pull may be slow due to image fetch.

## Commit/PR

- Commits: short imperative (e.g., “Add Modal tracing”).
- PRs: state what/why, how verified, note config/migrations; include chat UX screenshots when relevant.
