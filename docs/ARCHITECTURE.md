# Tintin - Architecture Documentation

Detailed system architecture, design patterns, and module relationships.

## System Layer Architecture

```mermaid
graph TB
    subgraph UI["User Interface Layer"]
        TG[Telegram Bot]
        SL[Slack Bot]
        CUI[Cloud UI]
    end

    subgraph Service["Service Layer"]
        SVC[service.ts<br/>HTTP Server]
        CTL[controller2.ts<br/>BotController]
        CTRL[controller/<br/>Modular Handlers]
        MSG[sessionMessenger.ts<br/>Message Routing]
        GHR[githubRoutes.ts<br/>GitHub REST API]
        AGR[agentRoutes.ts<br/>Agent Log Relay]
        WSH[websocket/handler<br/>Agent Execution]
    end

    subgraph Execution["Execution Layer"]
        SM[SessionManager]
        CM[CloudManager]
        MCP[McpRegistry]
    end

    subgraph Agent["Agent Layer"]
        AA[AgentAdapter]
        COD[Codex CLI]
        CC[Claude Code CLI]
    end

    subgraph Stream["Stream Layer"]
        JS[JsonlStreamer]
        TCM[ToolCallManager]
        PSM[PlaywrightScreenshotManager]
        PE[progress/<br/>ProgressExtractors]
    end

    subgraph Storage["Storage Layer"]
        DB[(Database)]
        JL[JSONL Files]
        S3[(S3 Artifacts)]
    end

    TG --> SVC
    SL --> SVC
    CUI -->|HTTP REST| GHR
    CUI -->|HTTP REST| AGR
    CUI -->|WebSocket| WSH
    SVC --> CTL
    CTL --> CTRL
    CTRL --> SM
    CTRL --> CM
    CTRL --> MSG
    GHR --> CM
    AGR --> CM
    WSH --> CM
    MSG -->|WS/Platform| CUI
    SM --> MCP
    SM --> AA
    CM --> AA
    AA --> COD
    AA --> CC
    COD --> JL
    CC --> JL
    JL --> JS
    JS --> TCM
    JS --> PSM
    JS --> PE
    JS --> MSG
    PE -->|WS only| MSG
    SM --> DB
    CM --> DB
    CM --> S3
```

## Module Dependency Graph

```mermaid
graph TD
    CTL[controller2.ts<br/>BotController]

    CTL --> TH[controller/<br/>telegramHandler]
    CTL --> SH[controller/<br/>slackHandler]
    CTL --> CH[controller/<br/>cloudHandler]

    CTL --> SM[sessionManager]
    CTL --> CM[cloudManager]
    CTL --> WH[websocket/<br/>handler]

    SM --> SS[session/<br/>StateMachine]
    SM --> SP[session/<br/>ProcessLifecycle]
    SM --> SE[session/<br/>EnvironmentBuilder]

    CM --> MP[cloud/<br/>modalProvider]
    CM --> LP[cloud/<br/>localProvider]
    CM --> CS[cloud/<br/>store]

    WH --> WSC[websocket/<br/>services/cloud]
    WH --> WSI[websocket/<br/>services/identity]

    GHR[service/http/<br/>githubRoutes] --> CR[cloud/<br/>repos]
    GHR --> GA[cloud/<br/>githubApp]
    GHR --> OA[cloud/<br/>oauth]
    GHR --> ST[store]

    AGR[service/http/<br/>agentRoutes] --> SMSG[service/<br/>sessionMessenger]
    CAR[service/http/<br/>cloudApiRoutes] --> CM

    SM --> AG[agents.ts]
    AG --> JS[streamer/<br/>JsonlStreamer]
    JS --> TM[streamer/<br/>ToolCallManager]
    JS --> EM[streamer/<br/>eventMappers]
    JS --> PE[streamer/<br/>progress]
    JS --> SMSG

    SM --> MR[mcp/<br/>registry]
    MR --> MF[mcp/<br/>factory]
```

## Architectural Patterns

### Strategy Pattern

```mermaid
classDiagram
    class AgentAdapter {
        <<interface>>
        +spawnExec()
        +monitor()
    }
    class CodexAgent {
        +spawnExec()
        +monitor()
    }
    class ClaudeCodeAgent {
        +spawnExec()
        +monitor()
    }
    class CloudProvider {
        <<interface>>
        +startRun()
        +getLogs()
    }
    class ModalProvider {
        +startRun()
        +getLogs()
    }
    class LocalProvider {
        +startRun()
        +getLogs()
    }

    AgentAdapter <|-- CodexAgent
    AgentAdapter <|-- ClaudeCodeAgent
    CloudProvider <|-- ModalProvider
    CloudProvider <|-- LocalProvider
```

### State Machine Pattern

Session state transitions:

```mermaid
stateDiagram-v2
    [*] --> wizard: createSession()
    wizard --> starting: initialize()
    starting --> running: process spawned
    starting --> error: spawn failed
    starting --> killed: user cancel
    running --> finished: exit=0
    running --> error: exit!=0
    running --> killed: user kill
    finished --> [*]
    error --> [*]
    killed --> [*]

    note right of wizard
        Initial state
        Waiting for configuration
    end note

    note right of running
        Agent executing
        JSONL streaming active
    end note
```

### Builder Pattern

```typescript
// EnvironmentBuilder fluent interface
EnvironmentBuilder.create()
    .withLanguage('zh')
    .withCloudProxy(config.cloud.proxyUrl)
    .withChatGptProxy(config.chatgpt.enabled)
    .withMcpServers(mcpRegistry.getServers())
    .build();
```

### Registry Pattern

```mermaid
classDiagram
    class McpRegistry {
        -Map~string, IMcpProvider~ providers
        +register(name, provider)
        +get(name)
        +startAll()
        +stopAll()
    }
    class IMcpProvider {
        <<interface>>
        +start()
        +stop()
        +callTool()
    }
    class StdioProvider {
        +start()
        +stop()
        +callTool()
    }
    class HttpProvider {
        +start()
        +stop()
        +callTool()
    }

    McpRegistry o-- IMcpProvider
    IMcpProvider <|-- StdioProvider
    IMcpProvider <|-- HttpProvider
```

### Dependency Injection

All services receive dependencies via constructor:

```typescript
class SessionManager {
    constructor(
        private db: Database,
        private config: Config,
        private logger: Logger,
        private mcpRegistry: McpRegistry,
    ) {}
}
```

Benefits:
- Testable with mock implementations
- Clear dependency graph
- Easy to swap implementations

### Observer Pattern

```mermaid
sequenceDiagram
    participant JS as JsonlStreamer
    participant CB as Callback
    participant TG as Telegram/Slack

    JS->>JS: pollOnce()
    JS->>JS: Parse JSONL
    JS->>CB: emit(fragment)
    CB->>TG: sendToSession()
    TG-->>JS: ACK
```

## Component Responsibilities

| Module | Responsibility | Key Methods |
|--------|----------------|-------------|
| **service.ts** | HTTP server & bot initialization | start(), handleOAuth() |
| **service/httpServer.ts** | HTTP server setup & route mounting | createServer(), mountRoutes() |
| **service/sessionMessenger.ts** | Platform message formatting & WebSocket routing | sendToSession(), formatFragment() |
| **service/http/githubRoutes.ts** | GitHub HTTP REST API (auth, repos, OAuth, disconnect) | handleGithubApiRoutes() |
| **service/http/agentRoutes.ts** | Agent log relay, execution API & progress timeline | handleAgentLogRelay(), progress-timeline |
| **service/http/cloudApiRoutes.ts** | Cloud API endpoints | handleCloudApiRoutes() |
| **controller2.ts** | Central BotController | handleChat(), handleInteraction() |
| **controller/telegramHandler.ts** | Telegram-specific handling | handleCommand(), handleCallback() |
| **controller/slackHandler.ts** | Slack-specific handling | handleCommand(), handleShortcut() |
| **controller/cloudHandler.ts** | Cloud command handling | cloudHelp(), cloudStatus() |
| **controller/interactionHandler.ts** | Button/selection handling | handleInteraction() |
| **sessionManager.ts** | Agent session lifecycle | startNew(), resumeSession(), kill() |
| **session/SessionStateMachine.ts** | State transition validation | canTransition(), transition() |
| **session/ProcessLifecycleManager.ts** | Process registration/kill | register(), killAll() |
| **session/EnvironmentBuilder.ts** | Fluent env var builder | withLanguage(), withCloudProxy() |
| **session/ChatGptProxyManager.ts** | ChatGPT OAuth proxy lifecycle | startProxy(), stopProxy() |
| **cloud/manager.ts** | Cloud run orchestration | startRun(), getLogs(), snapshot() |
| **cloud/modalProvider.ts** | Modal sandbox provider | createSandbox(), execute() |
| **cloud/localProvider.ts** | Local provider (testing) | createSandbox(), execute() |
| **cloud/repos.ts** | Centralized repo sync logic | syncReposForIdentity(), fetchGithubRepos() |
| **cloud/notion/** | Notion MCP OAuth integration | discovery, oauth, registration, token |
| **websocket/handler.ts** | WebSocket agent execution messaging | handleMessage(), authenticate() |
| **websocket/services/cloud.ts** | CloudRunService | handleCloudRun(), subscribeRun() |
| **websocket/services/sandboxLifecycle.ts** | Sandbox provisioning | provisionSandbox() |
| **streamer/JsonlStreamer.ts** | JSONL to StreamFragment + progress emission | pollOnce(), emitProgressEvents() |
| **streamer/ToolCallManager.ts** | Tool call/output pairing | push(), shift(), clear() |
| **streamer/PlanUpdateHandler.ts** | Plan update parsing | handlePlanUpdate() |
| **streamer/eventMappers/** | Agent-specific event mapping | claudeMapper, codexMapper, helpers |
| **streamer/progress/** | Progress event extraction (WS-only) | extractProgress(), claudeExtractor, codexExtractor |
| **mcp/registry.ts** | MCP server lifecycle | register(), startAll(), stopAll() |
| **platform/telegram.ts** | Telegram client | sendMessage(), sendPhoto() |
| **platform/slack.ts** | Slack client | postMessage(), update() |
