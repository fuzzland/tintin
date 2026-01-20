# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Tintin is a chat-based control interface (Telegram/Slack) for coding agents (Codex and Claude Code). It allows users to trigger coding tasks, run code, interact with repositories, and view results directly from chat platforms. Supports both local execution and cloud execution via Modal sandboxes.

## Build & Test Commands

```bash
npm run build          # TypeScript compilation (tsc -p tsconfig.build.json)
npm run typecheck      # Type validation without emitting
npm run test           # Build + run tests (Node.js built-in test runner)
npm run start          # Run daemon directly
npm run migrate        # Run database migrations

# Single test file
npm run build && node --test dist/tests/cloud-config.test.ts

# CLI access (after build)
node dist/tintin.js start|stop|status|log|restart
node dist/tinc.js lift|pull|attach
```

## Architecture

```
User Interface Layer:  Telegram / Slack / CLI (tinc) / Cloud UI
                              │
                              ▼
Session Orchestration: Controller2 + SessionManager
                              │
                    ┌─────────┼─────────┐
                    │         │         │
                    ▼         ▼         ▼
              Agents     Playwright   CloudManager
           (Codex/CC)      MCP      (Local/Modal)
                              │
                              ▼
Storage & Artifacts:   DB (Kysely) + JSONL/diff/screenshots/S3
```

### Key Modules (`src/runtime/`)

- **controller2.ts**: Central orchestration (4300+ LOC). Parses chat commands, manages conversation flow, coordinates sessions and cloud runs.
- **sessionManager.ts**: Agent session lifecycle - spawns processes, monitors JSONL output, handles termination.
- **streamer.ts**: Converts JSONL events to chat fragments with rate-limiting and chunking.
- **service.ts**: HTTP server & bot initialization - Slack webhooks, OAuth callbacks, UI endpoints.
- **agents.ts / codex.ts / claudeCode.ts**: Agent adapters spawning CLI processes, monitoring output.
- **cloud/manager.ts**: Cloud run orchestration - workspace creation, file uploads, execution, snapshots.
- **cloud/modalProvider.ts / localProvider.ts**: Pluggable providers implementing `CloudProvider` interface.

### Data Flow

**Local run**: Chat → Platform Adapter → controller2 → sessionManager → Agent (codex/claude) executes in local repo → JSONL events → streamer → Chat

**Cloud run (Modal)**: Chat → controller2 → cloud/manager → modalProvider creates sandbox → uploads repo → agent executes remotely → logs/screenshots via tunnel or S3 → Chat/UI

## Code Conventions

- ESM-only (`"type": "module"`)
- Node.js 20-25
- Strict TypeScript mode
- Use `import type` for type-only imports
- Dependency injection pattern (services passed to constructors)
- Use injected `logger` (not console.log) with debug/info/warn/error levels
- Async/await with `RateLimiter` and `TaskQueue` utilities in `util.ts`

## Configuration

All configuration is in `config.toml` (see `config.example.toml`). Key sections:
- `[bot]` - Host, port, data directory, log level
- `[db]` - Database URL (SQLite default, Postgres/MySQL supported)
- `[codex]` / `[claude_code]` - Agent binary paths and timeouts
- `[[projects]]` - Registered project paths
- `[telegram]` / `[slack]` - Platform credentials
- `[cloud]` - Provider (local/modal), Modal settings, proxy, OAuth
- `[playwright_mcp]` - Browser automation (local/browserbase/hyperbrowser)

Environment variables can be referenced as `env:VAR_NAME` in config values.

## Database

Uses Kysely ORM. Migrations in `src/runtime/migrations/`. Run `npm run migrate` after schema changes.
