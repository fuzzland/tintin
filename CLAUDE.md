# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Tintin is a chat-based control interface (Telegram/Slack/WebSocket) for coding agents (Codex and Claude Code). It allows users to trigger coding tasks, run code, interact with repositories, and view results directly from chat platforms. Supports both local execution and cloud execution via Modal sandboxes, with Cloud Proxy support for CLI agents.

## Build & Test Commands

```bash
npm run build          # TypeScript compilation (tsc -p tsconfig.build.json)
npm run typecheck      # Type validation without emitting
npm run test           # Build + run tests (Node.js built-in test runner)
npm run start          # Run daemon directly
npm run migrate        # Run database migrations

# Single test file
npm run build && node --test dist/tests/cloud-config.test.js

# Run specific module tests
npm run build && node --test dist/tests/streamer/*.test.js
npm run build && node --test dist/tests/session/*.test.js

# CLI access (after build)
node dist/tintin.js start|stop|status|log|restart
node dist/tinc.js lift|pull|attach
```

## Architecture

### System Layer Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                        User Interface Layer                        │
│      Telegram · Slack · WebSocket · Cloud UI · CLI                  │
└───────────────┬───────────────────────────────┬────────────────────┘
                │                               │
        ┌───────▼────────┐               ┌──────▼────────┐
        │ service.ts     │               │ WebSocket     │
        │ HTTP + Bots    │               │ manager.ts    │
        │ adapterFactory │               │ handler.ts    │
        └───────┬────────┘               └──────┬────────┘
                │                               │
        ┌───────▼────────┐               ┌──────▼────────┐
        │ Adapters       │               │ WS Adapter    │
        │ RequestRouter  │               │ + WS Chat     │
        │ (TG/Slack)     │               │ Orchestrator  │
        └───────┬────────┘               └──────┬────────┘
                │                               │
                └──────────────┬────────────────┘
                               │
                     ┌─────────▼─────────┐
                     │ Orchestrators     │
                     │ Session/Cloud/    │
                     │ Command/Wizard/   │
                     │ CommitProposal    │
                     └─────────┬─────────┘
                               │
                     ┌─────────▼─────────┐
                     │ SessionManager    │
                     │ CloudManager      │
                     │ JsonlStreamer     │
                     └─────────┬─────────┘
                               │
                     ┌─────────▼─────────┐
                     │ DB · JSONL · S3   │
                     └───────────────────┘
```

### Module Dependency Graph

```
┌────────────┐
│ service.ts │
└──────┬─────┘
       ├──────────────────────────────┐
       │                              │
       ▼                              ▼
┌────────────────┐            ┌──────────────────┐
│ adapterFactory │            │ WebSocket        │
│ RequestRouter  │            │ manager/handler  │
└──────┬─────────┘            └──────┬───────────┘
       │                              │
       ▼                              ▼
┌────────────────┐            ┌──────────────────────┐
│ TG/Slack        │            │ WebSocketChatOrch.   │
│ Adapters        │            │ WebSocketAdapter     │
└──────┬──────────┘            └─────────┬────────────┘
       │                               │
       └──────────────┬────────────────┘
                      ▼
               ┌──────────────┐
               │ Orchestrators│
               └──────┬───────┘
                      ▼
              ┌────────────────┐
              │ SessionManager │
              │ CloudManager   │
              │ JsonlStreamer  │
              └────────────────┘
```

## File Structure

### Core Runtime (`src/runtime/`)

```
src/runtime/
├── service.ts              # HTTP server & bot initialization
├── service/                # HTTP utilities, adapter factory, commit proposals
├── adapters/               # Platform adapters + request routing
│   ├── BaseAdapter.ts
│   ├── RequestRouter.ts
│   ├── TelegramAdapter.ts
│   ├── SlackAdapter.ts
│   ├── WebSocketAdapter.ts
│   └── telegram/           # Telegram-specific helpers (forum topics)
├── orchestrator/           # Platform-agnostic orchestration
│   ├── SessionOrchestrator.ts
│   ├── CloudOrchestrator.ts
│   ├── CommandOrchestrator.ts
│   ├── WizardOrchestrator.ts
│   ├── CommitProposalOrchestrator.ts
│   └── WebSocketChatOrchestrator.ts
├── websocket/              # WebSocket communication
│   ├── manager.ts          # Connection management
│   ├── handler.ts          # Message routing & auth
│   ├── guards.ts           # Auth guard utilities
│   ├── types.ts            # Protocol definitions
│   └── services/           # GitHub OAuth + sandbox lifecycle
│       ├── github.ts
│       ├── githubDisconnect.ts
│       └── sandboxLifecycle.ts
├── sessionManager.ts       # Agent session lifecycle
├── session/                # State machine + process lifecycle
├── streamer.ts             # JSONL to chat fragments
├── streamer/               # StreamFragment mappers + tool pairing
├── cloud/                  # Cloud execution + providers
├── platform/               # Telegram/Slack client wrappers
├── notification/           # Run completion notifications
├── shared/                 # Access control, UIBuilder, identity resolution
├── chat/                   # Chat session helpers + store
├── agents.ts               # Agent adapter interface
├── codex.ts                # Codex CLI adapter
├── claudeCode.ts           # Claude Code CLI adapter
├── config.ts               # Configuration loader
├── db.ts                   # Database types & connection
├── store.ts                # Data access layer
├── messaging.ts            # Platform message sending
├── redact.ts               # Secret redaction
└── migrations/             # Database migrations
```

### Tests (`tests/`)

```
tests/
├── adapters/
├── orchestrator/
├── websocket/
├── session/
├── streamer/
├── shared/
├── cloud/
└── runtime/
```

## Data Flow Diagrams

### Local Agent Run Flow

```
┌────────┐    message     ┌──────────────┐
│  User  │ ──────────────▶│   Telegram   │
└────────┘                │    /Slack    │
                          └──────┬───────┘
                                 │
                                 ▼
                          ┌──────────────┐
                          │  service.ts  │
                          │  (webhook)   │
                          └──────┬───────┘
                                 │
                                 ▼
                          ┌──────────────────┐
                          │ Adapter + Router │
                          │ (TG/Slack)       │
                          └──────┬───────────┘
                                 │
                                 ▼
                          ┌──────────────────┐
                          │ Orchestrators    │
                          │ Session/Command  │
                          │ Wizard/Cloud     │
                          └──────┬───────────┘
                                 │
                                 ▼
                          ┌──────────────┐
                          │SessionManager│
                          └──────┬───────┘
                                 │
                                 ▼
                          ┌──────────────┐
                          │ AgentAdapter │
                          │  spawnExec() │
                          └──────┬───────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │ CLI Process      │
                        │ codex/claudeCode │
                        └──────┬───────────┘
                               │ JSONL
                               ▼
                        ┌──────────────────┐
                        │ JsonlStreamer    │
                        └──────┬───────────┘
                               │
                               ▼
                        ┌──────────────────┐
                        │ Adapter send()   │
                        └──────┬───────────┘
                               │
                               ▼
                            ┌─────┐
                            │User │
                            └─────┘
```

### Tool Call Pairing Flow

```
┌──────────────────────────────────────────────────────────────┐
│                     JSONL Events                              │
└──────────────────────────────────────────────────────────────┘
         │
         │  {"type": "tool_use", "name": "Bash", ...}
         ▼
┌──────────────────┐
│ ToolCallManager  │
│   push(call)     │────────┐
└──────────────────┘        │
                            │ Queue: ["$ ls -la"]
         │                  │
         │  {"type": "tool_result", ...}
         ▼                  │
┌──────────────────┐        │
│ ToolCallManager  │◄───────┘
│   shift()        │
└────────┬─────────┘
         │
         │  Pair: (call, output)
         ▼
┌──────────────────┐
│formatToolPair    │
│   Message        │
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────┐
│  📎 $ ls -la                          │
│  ────────────────────────────────────│
│  total 48                             │
│  drwxr-xr-x  12 user  staff   384 ... │
│  -rw-r--r--   1 user  staff   156 ... │
└──────────────────────────────────────┘
```

### Session State Machine

```
                    ┌─────────┐
                    │  START  │
                    └────┬────┘
                         │
                         │ createSession()
                         ▼
                   ┌──────────┐
          ┌───────│ starting │───────┐
          │       └────┬─────┘       │
          │            │             │
     error│   success  │        kill │
          │            ▼             │
          │      ┌──────────┐        │
          │      │ running  │────────┤
          │      └────┬─────┘        │
          │           │              │
          │     ┌─────┴─────┐        │
          │     │           │        │
          │  exit=0    exit!=0       │
          │     │           │        │
          │     ▼           ▼        │
          │ ┌────────┐ ┌────────┐    │
          │ │finished│ │ error  │◄───┘
          │ └────────┘ └────┬───┘
          │                 │
          └─────────────────┴───────▶ ┌────────┐
                                      │ killed │
                                      └────────┘

Valid Transitions:
  - wizard   → starting
  - starting → running | error | killed
  - running  → finished | error | killed
  - finished → (terminal)
  - error    → (terminal)
  - killed   → (terminal)
```

### WebSocket Real-time Flow

```
┌────────────┐                              ┌────────────┐
│   Client   │                              │   Server   │
└─────┬──────┘                              └─────┬──────┘
      │                                           │
      │  ──────── WS Connect + Token ──────────▶  │
      │                                           │
      │                                    ┌──────┴──────┐
      │                                    │ Auth Check  │
      │                                    └──────┬──────┘
      │                                           │
      │  ◀─────── Connection Accepted ─────────  │
      │                                           │
      │  ──────── {"type": "chat",         ────▶  │
      │            "chatId": "uuid",              │
      │            "prompt": "Hello",             │
      │            "mode": "queue|interrupt"}     │
      │                                           │
      │  ◀─────── {"type": "run_status",  ─────  │
      │            "chatId": "uuid",              │
      │            "status": "queued"}            │
      │                                           │
      │  ◀─────── {"type": "chunk",       ─────  │
      │            "chatId": "uuid",              │
      │            "content": "I'll help"}        │
      │                                           │
      │  ◀─────── {"type": "tool_call",    ─────  │
      │            "chatId": "uuid",              │
      │            "name": "Read"}                │
      │                                           │
      │  ◀─────── {"type": "tool_output",  ─────  │
      │            "chatId": "uuid",              │
      │            "output": "..."}               │
      │                                           │
      │  ◀─────── {"type": "done"}         ─────  │
      │                                           │
```

### WebSocket Cloud Run Flow

```
┌────────────┐                              ┌────────────┐
│   Client   │                              │   Server   │
└─────┬──────┘                              └─────┬──────┘
      │                                           │
      │  ──────── {"type": "auth"} ───────────▶  │
      │  ◀─────── {"type": "auth_ok"} ─────────  │
      │                                           │
      │  ──────── {"type": "chat",         ────▶  │
      │            "chatId": "uuid",              │
      │            "repoIds": [...],              │
      │            "prompt": "Fix bug"}           │
      │                                           │
      │                                    ┌──────┴──────┐
      │                                    │CloudManager │
      │                                    │  startRun   │
      │                                    └──────┬──────┘
      │                                           │
      │  ◀─────── {"type": "run_status",   ─────  │
      │            "chatId": "uuid"}              │
      │  ◀─────── {"type": "browser_session"}     │
      │  ◀─────── {"type": "chunk", ...}   ─────  │
      │  ◀─────── {"type": "tool_call"}    ─────  │
      │  ◀─────── {"type": "tool_output"}  ─────  │
      │  ◀─────── {"type": "done"}         ─────  │
```

### Business Flow (High-level)

```
User (TG/Slack) → Adapter → RequestRouter → Orchestrators
  → SessionManager/CloudManager → JsonlStreamer → Adapter → User
```

```
WebSocket Client → WebSocketHandler → WebSocketChatOrchestrator
  → CloudManager → SessionManager → JsonlStreamer → WebSocketAdapter → Client
```

## Key Modules (`src/runtime/`)

### Core Modules

- **orchestrator/**: Platform-agnostic flows (session, cloud, command, wizard, commit proposals, WebSocket chat).
- **adapters/**: Telegram/Slack adapters + `RequestRouter`; WebSocketAdapter for outbound WS messages.
- **service/adapterFactory.ts**: Wires adapters ↔ orchestrators ↔ Session/Cloud managers.
- **sessionManager.ts**: Agent session lifecycle - spawns processes, monitors JSONL output, handles termination.
- **streamer.ts**: Converts JSONL events to chat fragments with rate-limiting and chunking.
- **service.ts**: HTTP server & bot initialization - Slack webhooks, OAuth callbacks, UI endpoints.
- **agents.ts / codex.ts / claudeCode.ts**: Agent adapters spawning CLI processes, monitoring output.

### Modular Components (Streamer)

- **streamer/ToolCallManager.ts**: FIFO queue for pairing tool calls with their outputs
- **streamer/PlanUpdateHandler.ts**: Parses plan updates and suppresses redundant outputs
- **streamer/PlaywrightScreenshotManager.ts**: Captures and sends browser screenshots via MCP
- **streamer/eventMappers/**: Converts agent-specific JSONL to unified StreamFragment format

### Modular Components (Session)

- **session/SessionStateMachine.ts**: Validates session state transitions (wizard→starting→running→finished/error/killed)
- **session/ProcessLifecycleManager.ts**: Manages agent process registration, timeouts, and termination
- **session/ChatGptProxyManager.ts**: Handles ChatGPT OAuth proxy process lifecycle
- **session/EnvironmentBuilder.ts**: Fluent builder for constructing agent environment variables

### Modular Components (Shared Services)

Cross-platform shared services that eliminate duplicate code across Telegram, Slack, and WebSocket handlers:

- **shared/AccessControl.ts**: Unified access control for all platforms - validates allowlists, workspace permissions, token auth
- **shared/ActionParser.ts**: Parses button interactions (callback_data, action_id) to typed actions (kill, review, commit, lang)
- **shared/UIBuilder.ts**: Builds platform-specific UI components (Telegram inline keyboards, Slack blocks) with i18n support
- **shared/IdentityResolver.ts**: Resolves user identities across platforms to database identity records

### Cloud & Integration

- **cloud/manager.ts**: Cloud run orchestration - workspace creation, file uploads, execution, snapshots.
- **cloud/modalProvider.ts / localProvider.ts**: Pluggable providers implementing `CloudProvider` interface.
- **cloud/proxy.ts**: Cloud Proxy token authentication - allows CLI agents to access cloud API endpoints securely.
- **websocket/**: WebSocket real-time communication
  - `manager.ts` manages connections, `handler.ts` routes messages
  - `orchestrator/WebSocketChatOrchestrator.ts` handles `chat`/`stop`/`subscribe`
  - `adapters/WebSocketAdapter.ts` emits WS responses
  - `services/` handles GitHub OAuth + sandbox lifecycle
- **chatgpt/**: ChatGPT OAuth integration - `oauth.ts` handles authentication flow, `store.ts` manages tokens.

## Code Conventions

- ESM-only (`"type": "module"`)
- Node.js 20-25
- Strict TypeScript mode
- Use `import type` for type-only imports
- Dependency injection pattern (services passed to constructors)
- Use injected `logger` (not console.log) with debug/info/warn/error levels
- Async/await with `RateLimiter` and `TaskQueue` utilities in `util.ts`
- Single Responsibility Principle - each module has one focused purpose
- Fluent builder pattern for complex object construction (EnvironmentBuilder)
- State machine pattern for lifecycle management (SessionStateMachine)

## Configuration

All configuration is in `config.toml` (see `config.example.toml`). Key sections:
- `[bot]` - Host, port, data directory, log level
- `[db]` - Database URL (SQLite default, Postgres/MySQL supported)
- `[codex]` / `[claude_code]` - Agent binary paths and timeouts
- `[[projects]]` - Registered project paths
- `[telegram]` / `[slack]` - Platform credentials
- `[cloud]` - Provider (local/modal), Modal settings, proxy, OAuth
- `[mcp]` - MCP providers (Playwright, stdio/http, etc.)

Environment variables can be referenced as `env:VAR_NAME` in config values.

## Database

Uses Kysely ORM. Migrations in `src/runtime/migrations/`. Run `npm run migrate` after schema changes.

Key tables:
- `sessions` - Agent session records with status, timestamps, exit codes
- `session_offsets` - JSONL file read positions for streaming
- `identities` - User identities across platforms
- `workspaces` - Cloud workspace metadata
