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
┌─────────────────────────────────────────────────────────────────┐
│                      User Interface Layer                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │ Telegram │  │  Slack   │  │WebSocket │  │    Cloud UI      │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘ │
└───────┼─────────────┼─────────────┼─────────────────┼───────────┘
        │             │             │                 │
        └─────────────┴──────┬──────┴─────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────────┐
│                      Service Layer                               │
│                             │                                    │
│  ┌──────────────────────────▼───────────────────────────────┐   │
│  │                   service.ts                              │   │
│  │  HTTP Server · Bot Init · OAuth Callbacks · UI Endpoints  │   │
│  └──────────────────────────┬───────────────────────────────┘   │
│                             │                                    │
│  ┌──────────────────────────▼───────────────────────────────┐   │
│  │                  controller2.ts                           │   │
│  │   Command Parser · Conversation Flow · Session Dispatch   │   │
│  └────┬─────────────────────┬───────────────────────┬───────┘   │
└───────┼─────────────────────┼───────────────────────┼───────────┘
        │                     │                       │
┌───────┼─────────────────────┼───────────────────────┼───────────┐
│       │       Execution Layer                       │           │
│       │                     │                       │           │
│  ┌────▼─────────────┐  ┌────▼─────────────┐  ┌─────▼────────┐  │
│  │  SessionManager  │  │   CloudManager   │  │ Cloud Proxy  │  │
│  │  ┌─────────────┐ │  │  ┌────────────┐  │  │ (token auth) │  │
│  │  │StateMachine │ │  │  │ModalProvider│ │  └──────────────┘  │
│  │  │ProcessMgr   │ │  │  │LocalProvider│ │                    │
│  │  │ChatGptProxy │ │  │  └────────────┘  │                    │
│  │  │EnvBuilder   │ │  └──────────────────┘                    │
│  │  └─────────────┘ │                                          │
│  └────────┬─────────┘                                          │
└───────────┼────────────────────────────────────────────────────┘
            │
┌───────────┼────────────────────────────────────────────────────┐
│           │           Agent Layer                               │
│  ┌────────▼─────────┐                                          │
│  │   AgentAdapter   │  ← Strategy Pattern                      │
│  │  ┌─────────────┐ │                                          │
│  │  │ CodexAgent  │ │  CLI: codex --json                       │
│  │  │ ClaudeAgent │ │  CLI: claude --output-format stream-json │
│  │  └─────────────┘ │                                          │
│  └────────┬─────────┘                                          │
└───────────┼────────────────────────────────────────────────────┘
            │ JSONL Output
┌───────────┼────────────────────────────────────────────────────┐
│           │         Stream Layer                                │
│  ┌────────▼─────────────────────────────────────────────────┐  │
│  │                    JsonlStreamer                          │  │
│  │  ┌────────────────┐  ┌─────────────────────────────────┐ │  │
│  │  │ToolCallManager│  │ PlaywrightScreenshotManager     │ │  │
│  │  │PlanUpdateHdlr │  │ EventMappers (Codex/Claude)     │ │  │
│  │  └────────────────┘  └─────────────────────────────────┘ │  │
│  └──────────────────────────────┬───────────────────────────┘  │
└─────────────────────────────────┼──────────────────────────────┘
                                  │ StreamFragment
┌─────────────────────────────────┼──────────────────────────────┐
│                                 │      Storage Layer           │
│  ┌──────────────┐  ┌────────────▼───┐  ┌───────────────────┐  │
│  │   Database   │  │  JSONL Files   │  │   S3 Artifacts    │  │
│  │   (Kysely)   │  │  (sessions)    │  │  (screenshots)    │  │
│  └──────────────┘  └────────────────┘  └───────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

### Module Dependency Graph

```
┌─────────────┐
│ controller2 │
└──────┬──────┘
       │
       ├────────────────┬────────────────┬─────────────────┐
       │                │                │                 │
       ▼                ▼                ▼                 ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│SessionManager│ │ CloudManager │ │   Streamer   │ │ WebSocket    │
│              │ │              │ │              │ │   Handler    │
└──────┬───────┘ └──────────────┘ └──────┬───────┘ └──────────────┘
       │                                 │
       │                                 │
       ▼                                 ▼
┌──────────────┐                  ┌──────────────┐
│ AgentAdapter │                  │ EventMappers │
│ (Codex/CC)   │                  │              │
└──────────────┘                  └──────────────┘
```

## File Structure

### Core Runtime (`src/runtime/`)

```
src/runtime/
├── service.ts              # HTTP server & bot initialization
├── controller2.ts          # Central orchestration (4300+ LOC)
├── sessionManager.ts       # Agent session lifecycle
├── streamer.ts             # JSONL to chat fragments
├── agents.ts               # Agent adapter interface
├── codex.ts                # Codex CLI adapter
├── claudeCode.ts           # Claude Code CLI adapter
├── config.ts               # Configuration loader
├── db.ts                   # Database types & connection
├── store.ts                # Data access layer
├── messaging.ts            # Platform message sending
├── playwrightMcp.ts        # Playwright MCP integration
├── prompt.ts               # Prompt building utilities
├── redact.ts               # Secret redaction
├── util.ts                 # Shared utilities
│
├── streamer/               # Modular streamer components
│   ├── index.ts            # Public exports
│   ├── types.ts            # StreamFragment, MessageVerbosity
│   ├── ToolCallManager.ts  # Tool call/output pairing queue
│   ├── PlanUpdateHandler.ts # Plan update parsing
│   ├── PlaywrightScreenshotManager.ts # Browser screenshots
│   └── eventMappers/
│       ├── index.ts        # EVENT_MAPPERS registry
│       ├── helpers.ts      # Shared formatting utilities
│       ├── codexMapper.ts  # Codex JSONL → StreamFragment
│       ├── claudeMapper.ts # Claude JSONL → StreamFragment
│       └── messageDispatcher.ts # event_msg handling
│
├── session/                # Modular session components
│   ├── index.ts            # Public exports
│   ├── types.ts            # SessionStatus, VALID_TRANSITIONS
│   ├── SessionStateMachine.ts  # State transition validation
│   ├── ProcessLifecycleManager.ts # Process registration/kill
│   ├── ChatGptProxyManager.ts  # ChatGPT OAuth proxy
│   └── EnvironmentBuilder.ts   # Fluent env var builder
│
├── cloud/                  # Cloud execution
│   ├── manager.ts          # Cloud run orchestration
│   ├── modalProvider.ts    # Modal sandbox provider
│   ├── localProvider.ts    # Local provider (testing)
│   ├── proxy.ts            # Cloud Proxy token auth
│   └── store.ts            # Identity/workspace storage
│
├── websocket/              # WebSocket communication
│   ├── manager.ts          # Connection management
│   ├── handler.ts          # Message routing & auth
│   ├── guards.ts           # Auth guard utilities
│   ├── types.ts            # Protocol definitions
│   └── services/           # WebSocket message handlers
│       ├── index.ts        # Public exports
│       ├── identity.ts     # IdentityResolver - WS identity mapping
│       ├── linkBuilder.ts  # CloudLinkBuilder - URL construction
│       ├── cloud.ts        # CloudRunService - cloud_run handling
│       ├── session.ts      # SessionService - local chat handling
│       └── github.ts       # GitHubService - OAuth & repos
│
├── chatgpt/                # ChatGPT OAuth
│   ├── oauth.ts            # Auth flow handling
│   └── store.ts            # Token storage
│
└── migrations/             # Database migrations
```

### Tests (`tests/`)

```
tests/
├── cloud-config.test.ts
├── cloud-proxy.test.ts
├── cloud-modal-provider.test.ts
├── cloud-modal-logs.test.ts
│
├── streamer/
│   ├── ToolCallManager.test.ts
│   ├── PlanUpdateHandler.test.ts
│   └── eventMappers/
│       ├── helpers.test.ts
│       ├── codexMapper.test.ts
│       └── claudeMapper.test.ts
│
└── session/
    ├── types.test.ts
    ├── SessionStateMachine.test.ts
    ├── ProcessLifecycleManager.test.ts
    └── EnvironmentBuilder.test.ts
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
                          ┌──────────────┐
                          │ controller2  │
                          │ handleChat() │
                          └──────┬───────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
              ▼                  ▼                  ▼
       ┌────────────┐    ┌────────────┐     ┌────────────┐
       │ New Session│    │Resume Sess │     │  Kill Sess │
       └─────┬──────┘    └─────┬──────┘     └────────────┘
             │                 │
             └────────┬────────┘
                      │
                      ▼
              ┌──────────────┐     env vars
              │SessionManager│ ◄────────────┐
              │startNew/     │              │
              │resumeSession │     ┌────────┴────────┐
              └──────┬───────┘     │EnvironmentBuilder│
                     │             │ - Language       │
                     │             │ - CloudProxy     │
                     │             │ - ChatGptProxy   │
                     │             └─────────────────┘
                     ▼
              ┌──────────────┐
              │ AgentAdapter │
              │  spawnExec() │
              └──────┬───────┘
                     │
                     ▼
         ┌─────────────────────┐
         │   CLI Process       │
         │ codex / claude-code │
         │                     │
         │  stdin ◄── prompt   │
         │  stdout ──▶ JSONL   │
         └──────────┬──────────┘
                    │
                    ▼ (write to file)
         ┌─────────────────────┐
         │    JSONL File       │
         │ ~/.tintin/sessions/ │
         └──────────┬──────────┘
                    │
                    │ (poll every N ms)
                    ▼
         ┌─────────────────────┐
         │   JsonlStreamer     │
         │     pollOnce()      │
         └──────────┬──────────┘
                    │
                    ▼
         ┌─────────────────────┐
         │   EVENT_MAPPERS     │
         │ - codexMapper       │
         │ - claudeMapper      │
         └──────────┬──────────┘
                    │
                    ▼
         ┌─────────────────────┐
         │  StreamFragment     │
         │ - text              │
         │ - tool_call         │
         │ - tool_output       │
         │ - plan_update       │
         └──────────┬──────────┘
                    │
                    ▼
         ┌─────────────────────┐
         │  sendToSession()    │
         │  (rate-limited)     │
         └──────────┬──────────┘
                    │
                    ▼
         ┌─────────────────────┐
         │  Telegram / Slack   │
         │     / WebSocket     │
         └──────────┬──────────┘
                    │
                    ▼
              ┌──────────┐
              │   User   │
              └──────────┘
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
      │            "content": "Hello"}            │
      │                                           │
      │                                    ┌──────┴──────┐
      │                                    │  Handler    │
      │                                    │handleMessage│
      │                                    └──────┬──────┘
      │                                           │
      │                                    ┌──────┴──────┐
      │                                    │ Session     │
      │                                    │ Manager     │
      │                                    └──────┬──────┘
      │                                           │
      │  ◀─────── {"type": "fragment",     ─────  │
      │            "text": "I'll help..."}        │
      │                                           │
      │  ◀─────── {"type": "tool_call",    ─────  │
      │            "name": "Read"}                │
      │                                           │
      │  ◀─────── {"type": "tool_output",  ─────  │
      │            "content": "..."}              │
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
      │  ──────── {"type": "cloud_run",    ────▶  │
      │            "repoIds": [...],              │
      │            "prompt": "Fix bug"}           │
      │                                           │
      │                                    ┌──────┴──────┐
      │                                    │CloudRunSvc  │
      │                                    │handleCloudRun│
      │                                    └──────┬──────┘
      │                                           │
      │                                    ┌──────┴──────┐
      │                                    │CloudManager │
      │                                    │  startRun   │
      │                                    └──────┬──────┘
      │                                           │
      │  ◀─────── {"type": "run_status"}   ─────  │
      │  ◀─────── {"type": "session_started"} ──  │
      │  ◀─────── {"type": "run_links"}    ─────  │
      │  ◀─────── {"type": "chunk", ...}   ─────  │
      │  ◀─────── {"type": "tool_call"}    ─────  │
      │  ◀─────── {"type": "tool_output"}  ─────  │
      │  ◀─────── {"type": "done"}         ─────  │
```

## Key Modules (`src/runtime/`)

### Core Modules

- **controller2.ts**: Central orchestration (4300+ LOC). Parses chat commands, manages conversation flow, coordinates sessions and cloud runs.
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

### Cloud & Integration

- **cloud/manager.ts**: Cloud run orchestration - workspace creation, file uploads, execution, snapshots.
- **cloud/modalProvider.ts / localProvider.ts**: Pluggable providers implementing `CloudProvider` interface.
- **cloud/proxy.ts**: Cloud Proxy token authentication - allows CLI agents to access cloud API endpoints securely.
- **websocket/**: WebSocket real-time communication
  - `manager.ts` manages connections, `handler.ts` routes messages
  - `services/CloudRunService` handles `cloud_run` and `subscribe_run` for cloud sandbox execution
  - `services/SessionService` handles local `chat` sessions
  - `services/GitHubService` handles OAuth and repository listing
  - `services/IdentityResolver` maps WebSocket identities to database identities
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
- `[playwright_mcp]` - Browser automation (local/browserbase/hyperbrowser)

Environment variables can be referenced as `env:VAR_NAME` in config values.

## Database

Uses Kysely ORM. Migrations in `src/runtime/migrations/`. Run `npm run migrate` after schema changes.

Key tables:
- `sessions` - Agent session records with status, timestamps, exit codes
- `session_offsets` - JSONL file read positions for streaming
- `identities` - User identities across platforms
- `workspaces` - Cloud workspace metadata
