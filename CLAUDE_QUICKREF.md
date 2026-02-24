# Tintin - Quick Reference

Quick commands and common operations for Claude Code working with Tintin.

## 🚀 Build & Test Commands

```bash
npm run build          # TypeScript compilation
npm run typecheck      # Type validation without emitting
npm run test           # Build + run tests
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

## 📁 Key File Locations

| Path | Purpose |
|------|---------|
| `src/runtime/controller2.ts` | Central BotController (367 LOC) |
| `src/runtime/sessionManager.ts` | Session lifecycle (1174 LOC) |
| `src/runtime/streamer/JsonlStreamer.ts` | JSONL streaming + progress extraction (852 LOC) |
| `src/runtime/streamer/progress/` | Progress event extraction pipeline (399 LOC) |
| `src/runtime/cloud/manager.ts` | Cloud orchestration (4699 LOC) |
| `src/runtime/service/sessionMessenger.ts` | Platform message formatting & WS routing (759 LOC) |
| `src/runtime/service/http/agentRoutes.ts` | Agent log relay, cloud API & progress timeline (935 LOC) |
| `src/runtime/service/http/githubRoutes.ts` | GitHub REST API (487 LOC) |
| `src/runtime/mcp/registry.ts` | MCP server registry (108 LOC) |
| `src/runtime/websocket/handler.ts` | WebSocket routing (256 LOC) |
| `config.toml` | Configuration file |

## 🏗️ Architecture Layers

```
User Interface (Telegram/Slack/WebSocket)
    ↓
Service Layer (service.ts → controller2.ts)
    ↓
Controller Layer (controller/telegramHandler.ts, etc.)
    ↓
Execution Layer (SessionManager, CloudManager, McpRegistry)
    ↓
Agent Layer (Codex, Claude Code)
    ↓
Stream Layer (JsonlStreamer → StreamFragment + ProgressEvent)
    ↓
Storage Layer (Database, JSONL, S3)
```

## 🔧 Common Operations

### Starting a Session
```typescript
// Via SessionManager
await sessionManager.startNew(identityId, agentType, prompt);
```

### Cloud Run
```typescript
// Via CloudManager
await cloudManager.startRun(identityId, repoIds, prompt);
```

### WebSocket Message Flow
```typescript
// Client → Server
{ type: "chat", content: "Hello" }
// Server → Client
{ type: "fragment", text: "Response" }
```

## 📦 Module Categories

| Category | Modules |
|----------|---------|
| **Core** | service.ts, controller2.ts, sessionManager.ts |
| **Controller** | telegramHandler.ts, slackHandler.ts, cloudHandler.ts, interactionHandler.ts |
| **Service** | httpServer.ts, sessionMessenger.ts, http/agentRoutes.ts, http/cloudApiRoutes.ts, http/githubRoutes.ts |
| **Session** | SessionStateMachine.ts, ProcessLifecycleManager.ts, EnvironmentBuilder.ts, ChatGptProxyManager.ts |
| **Streamer** | JsonlStreamer.ts, ToolCallManager.ts, PlanUpdateHandler.ts, eventMappers/, progress/ |
| **Cloud** | manager.ts, store.ts, modalProvider.ts, localProvider.ts, githubApp.ts, notion/ |
| **WebSocket** | manager.ts, handler.ts, services/cloud.ts, services/sandboxLifecycle.ts |
| **MCP** | registry.ts, factory.ts, providers/ (stdio, http, github, exa, parallel, playwright) |
| **Platform** | telegram.ts, slack.ts |

## 🔗 Full Documentation

- [Architecture Details](docs/ARCHITECTURE.md)
- [Module Reference](docs/MODULES.md)
- [Data Flows](docs/DATA_FLOW.md)
- [Configuration Guide](docs/CONFIGURATION.md)
