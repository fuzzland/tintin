# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 📖 Documentation Navigation

| Document | Description |
|----------|-------------|
| **[Quick Reference](CLAUDE_QUICKREF.md)** | Common commands, key files, quick operations |
| **[Architecture](docs/ARCHITECTURE.md)** | System architecture, design patterns, module relationships |
| **[Module Reference](docs/MODULES.md)** | Detailed module documentation with LOC and responsibilities |
| **[Data Flows](docs/DATA_FLOW.md)** | Sequence diagrams for key processes |
| **[Configuration](docs/CONFIGURATION.md)** | Complete config.toml reference |

## 🎯 Project Overview

Tintin is a chat-based control interface (Telegram/Slack/WebSocket) for coding agents (Codex and Claude Code). It allows users to trigger coding tasks, run code, interact with repositories, and view results directly from chat platforms.

**Key Features:**
- Multi-platform support (Telegram, Slack, WebSocket)
- Local and cloud execution (Modal sandboxes)
- Model Context Protocol (MCP) integration
- Multi-language support (en, zh)

## 🚀 Quick Start

```bash
npm run build          # TypeScript compilation
npm run test           # Build + run tests
npm run start          # Run daemon
npm run migrate        # Database migrations
```

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  User Interface Layer                                       │
│  Telegram Bot │ Slack Bot │ Cloud UI                        │
│                             (HTTP REST + WebSocket)         │
├─────────────────────────────────────────────────────────────┤
│  Service Layer                                              │
│  service.ts → controller2.ts → controller/* (handlers)      │
│  githubRoutes (HTTP REST) │ websocket/handler (Agent Exec)  │
├─────────────────────────────────────────────────────────────┤
│  Execution Layer                                            │
│  SessionManager │ CloudManager │ McpRegistry                │
├─────────────────────────────────────────────────────────────┤
│  Agent Layer                                                │
│  Codex CLI │ Claude Code CLI                                │
├─────────────────────────────────────────────────────────────┤
│  Stream Layer                                               │
│  JsonlStreamer → StreamFragment → Platform                  │
│                → progress/ → ProgressEvent → WebSocket only │
├─────────────────────────────────────────────────────────────┤
│  Storage Layer                                              │
│  Database (SQLite/Postgres) │ JSONL Files │ S3             │
└─────────────────────────────────────────────────────────────┘
```

## 📦 Core Modules

| Module | LOC | Responsibility |
|--------|-----|----------------|
| **controller2.ts** | 367 | Central BotController - platform dispatch, command routing |
| **sessionManager.ts** | 1174 | Agent session lifecycle - spawn, monitor, terminate |
| **cloud/manager.ts** | 4699 | Cloud orchestration - Modal/Local providers |
| **streamer/JsonlStreamer.ts** | 852 | JSONL to chat fragments + progress event extraction |
| **streamer/progress/** | 399 | Agent-agnostic progress event extraction pipeline |
| **service/sessionMessenger.ts** | 759 | Platform message formatting & WebSocket routing |
| **service/http/agentRoutes.ts** | 935 | Agent log relay, cloud API & progress timeline |
| **service/http/githubRoutes.ts** | 487 | GitHub HTTP REST API (auth, repos, OAuth, disconnect) |
| **websocket/handler.ts** | 256 | WebSocket agent execution messaging |
| **mcp/registry.ts** | 108 | MCP server lifecycle management |

## 🔧 File Structure

```
src/runtime/
├── Core Modules
│   ├── service.ts              # HTTP server & bot initialization
│   ├── controller2.ts          # Central BotController
│   ├── sessionManager.ts       # Session lifecycle
│   ├── streamer/               # JSONL streaming components
│   │   ├── eventMappers/       # Agent-specific event mapping
│   │   └── progress/           # Progress event extraction pipeline (WS-only)
│   ├── cloud/                  # Cloud execution (30+ files)
│   │   ├── repos.ts            # Centralized repo sync logic
│   │   └── notion/             # Notion MCP OAuth integration
│   ├── service/
│   │   ├── httpServer.ts       # HTTP server setup & route mounting
│   │   ├── sessionMessenger.ts # Platform message formatting & WS routing
│   │   └── http/
│   │       ├── githubRoutes.ts # GitHub REST API endpoints
│   │       ├── agentRoutes.ts  # Agent log relay & execution routes
│   │       └── cloudApiRoutes.ts # Cloud API endpoints
│   ├── websocket/              # WebSocket agent execution
│   │   └── services/           # CloudRunService, identity, sandbox
│   ├── mcp/                    # Model Context Protocol
│   │   └── providers/          # stdio, http, github, exa, parallel, playwright
│   ├── platform/               # Platform adapters (Telegram/Slack)
│   └── controller/             # Modular handlers
└── migrations/                 # Database migrations (29 files)
```

## 🎨 Design Patterns

| Pattern | Usage |
|---------|-------|
| **Strategy** | AgentAdapter, CloudProvider, IMcpProvider, IMessagingPlatform |
| **State Machine** | SessionStateMachine (wizard→starting→running→finished/error/killed) |
| **Builder** | EnvironmentBuilder (fluent env var construction) |
| **Factory** | mcp/factory.ts, platform/adapters.ts |
| **Registry** | mcp/registry.ts, streamer/eventMappers, streamer/progress |
| **Dependency Injection** | All services receive deps via constructor |

## 💾 Database

**ORM:** Kysely (supports SQLite/PostgreSQL/MySQL)

**Key Tables (33 total):**
- `sessions` - Agent session records
- `identities` - User identities with preferences
- `projects` - Projects (repo or playground) binding
- `connections` - OAuth connections
- `cloud_runs` / `cloud_workspaces` / `cloud_snapshots` - Cloud execution
- `repos` / `shared_repos` - Connected repositories
- `github_installations` / `github_webhook_events` - GitHub App integration
- `chatgpt_accounts` / `slack_installations` - Platform OAuth
- `notion_mcp_clients` / `notion_mcp_tokens` - Notion MCP OAuth
- `exa_api_keys` / `parallel_api_keys` - MCP provider keys

## 🌐 Internationalization

**Supported Languages:** en (English), zh (Chinese)

**Configuration Levels:**
1. User preference (`user_preferences` table)
2. Identity preference (`identities` table)
3. Session level (`EnvironmentBuilder.withLanguage()`)

## 📝 Code Conventions

- ESM-only (`"type": "module"`)
- Node.js 20-25
- Strict TypeScript mode
- Use `import type` for type-only imports
- Dependency injection pattern
- Use injected `logger` (not console.log)
- Async/await with `RateLimiter` and `TaskQueue`

## 🔗 Related Resources

- **[Project README](README.md)** - User-facing documentation
- **[AGENTS.md](AGENTS.md)** - Agent-specific documentation
- **[config.example.toml](config.example.toml)** - Configuration template

## 📚 External References

- [Claude Code Documentation](https://docs.anthropic.com/claude-code)
- [MCP Specification](https://modelcontextprotocol.io)
- [Modal Documentation](https://modal.com/docs)
