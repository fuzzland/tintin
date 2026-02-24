# Tintin - Data Flow Documentation

Detailed data flow diagrams for key system processes.

## Local Agent Run Flow

```mermaid
sequenceDiagram
    participant U as User
    participant P as Platform (TG/Slack)
    participant S as service.ts
    participant C as controller2.ts
    participant SM as SessionManager
    participant EB as EnvironmentBuilder
    participant AA as AgentAdapter
    participant CLI as CLI Process
    participant JL as JSONL File
    participant JS as JsonlStreamer
    participant EM as EventMappers
    participant MSG as Messenger

    U->>P: Send message
    P->>S: Webhook
    S->>C: handleChat()

    alt New Session
        C->>SM: startNew()
    else Resume Session
        C->>SM: resumeSession()
    else Kill Session
        C->>SM: kill()
    end

    SM->>EB: buildEnvironment()
    EB-->>SM: env vars
    SM->>AA: spawnExec(env)

    AA->>CLI: Spawn process
    CLI->>JL: Write JSONL

    loop Poll (every N ms)
        JS->>JL: Read new lines
        JL-->>JS: JSONL events
        JS->>EM: mapToFragment()
        EM-->>JS: StreamFragment[]
        JS->>MSG: sendToSession()
        MSG->>P: Send to user
    end

    CLI->>SM: Exit
    SM->>MSG: Final status
```

## Tool Call Pairing Flow

```mermaid
sequenceDiagram
    participant J as JSONL Stream
    participant TCM as ToolCallManager
    participant F as Formatter
    participant M as Messenger

    Note over TCM: Queue is empty

    J->>TCM: {"type": "tool_use", "name": "Bash", ...}
    TCM->>TCM: push(call)
    Note over TCM: Queue: ["$ ls -la"]

    J->>TCM: {"type": "tool_result", ...}
    TCM->>TCM: shift()
    Note over TCM: Pair matched!

    TCM->>F: formatToolPair(call, output)
    F->>M: Send formatted message
```

## Session State Machine

```mermaid
stateDiagram-v2
    [*] --> wizard: createSession()

    wizard --> starting: initialize()

    starting --> running: Process spawned successfully
    starting --> error: Spawn failed
    starting --> killed: User cancelled

    running --> finished: Exit code = 0
    running --> error: Exit code != 0
    running --> killed: User killed

    finished --> [*]
    error --> [*]
    killed --> [*]

    note right of wizard
        Initial state
        Waiting for configuration
    end note

    note right of running
        Agent process active
        JSONL streaming
        User can interact
    end note

    note right of finished
        Successful completion
        Output saved
    end note
```

## GitHub HTTP REST Flow

```mermaid
sequenceDiagram
    participant C as Client
    participant HTTP as HTTP Server
    participant GHR as githubRoutes
    participant CR as cloud/repos
    participant OA as cloud/oauth
    participant GA as cloud/githubApp
    participant DB as Database
    participant GH as GitHub API

    Note over C, GH: All GitHub operations use HTTP REST (not WebSocket)

    C->>HTTP: GET /api/github/auth-status
    HTTP->>GHR: verifyProxyToken()
    GHR->>DB: Query connections
    GHR-->>C: {"connected": true, "login": "user"}

    C->>HTTP: GET /api/github/repos?search=foo
    HTTP->>GHR: verifyProxyToken()
    GHR->>CR: syncReposForIdentity()
    CR->>GH: Fetch repos (paginated)
    CR->>DB: Upsert repos
    GHR-->>C: {"repos": [...], "stale": false}

    C->>HTTP: POST /api/github/oauth/start
    HTTP->>GHR: verifyProxyToken()
    GHR->>OA: generateState()
    GHR-->>C: {"authUrl": "https://github.com/login/oauth/..."}

    C->>HTTP: POST /api/github/disconnect {"confirm": false}
    HTTP->>GHR: verifyProxyToken()
    GHR->>DB: Compute impact (repos, runs, sessions)
    GHR-->>C: {"impact": {...}, "confirmToken": "abc123"}

    C->>HTTP: POST /api/github/disconnect {"confirm": true, "token": "abc123"}
    GHR->>DB: Delete connections & repos
    GHR-->>C: {"success": true}
```

## WebSocket Agent Execution Flow

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant H as Handler
    participant CRS as CloudRunService
    participant CM as CloudManager
    participant CP as CloudProvider
    participant A as Agent

    C->>S: WS Connect + Token
    S->>S: Auth Check

    alt Auth Failed
        S-->>C: Connection Rejected
    else Auth Success
        S-->>C: {"type": "auth_result", "success": true}
    end

    Note over C, A: WebSocket handles only agent execution messages

    C->>S: {"type": "cloud_run", "repoIds": [...], "prompt": "..."}
    S->>CRS: handleCloudRun()
    CRS->>CM: startRun()
    CM->>CP: Create sandbox
    CP-->>CM: sandboxId
    CM->>A: Start agent

    CRS-->>C: {"type": "run_status", "status": "starting"}
    CRS-->>C: {"type": "sandbox_status", "ready": true}

    loop Agent Processing
        A->>CM: JSONL event
        CM->>CRS: StreamChunk
        CRS-->>C: {"type": "chunk", "content": "..."}
    end

    CM->>CRS: Links ready
    CRS-->>C: {"type": "run_links", "logs": "...", "ui": "..."}

    A->>CM: Done
    CRS-->>C: {"type": "done", "exitCode": 0}

    Note over C, S: Follow-up and stop
    C->>S: {"type": "cloud_follow_up", "content": "..."}
    C->>S: {"type": "cloud_stop"}
```

## MCP Server Lifecycle

```mermaid
stateDiagram-v2
    [*] --> registered: Register in config

    registered --> starting: SessionManager.startAll()

    starting --> ready: Server process started
    starting --> failed: Start failed

    ready --> busy: Processing tool call
    busy --> ready: Call complete

    ready --> stopping: SessionManager.stopAll()
    busy --> stopping: Graceful shutdown

    stopping --> stopped: Process exited
    stopped --> [*]
    failed --> [*]
```

## Cloud Execution Flow

```mermaid
sequenceDiagram
    participant U as User
    participant CM as CloudManager
    participant CP as CloudProvider
    participant S as S3 Storage
    participant A as Agent
    participant DB as Database

    U->>CM: startRun(repoIds, prompt)
    CM->>DB: Create cloud_run record
    CM->>CP: Create sandbox
    CP-->>CM: sandboxId

    CM->>DB: Create workspace record

    par Upload Repos
        CM->>S: Upload repo1.zip
        CM->>S: Upload repo2.zip
    end

    CM->>CP: Execute agent
    CP->>A: Spawn process
    A->>CP: JSONL output
    CP-->>CM: Stream events

    loop Processing
        CM->>DB: Update run status
        CM->>U: Send fragments
    end

    A->>CP: Exit
    CP-->>CM: Exit code
    CM->>DB: Final status
    CM->>S: Create snapshot

    alt User wants artifacts
        CM->>S: Download artifacts
        S-->>U: Return files
    end
```

## GitHub App Integration Flow

```mermaid
sequenceDiagram
    participant GH as GitHub
    participant WH as githubWebhook
    participant CM as CloudManager
    participant A as Agent

    GH->>WH: Push event
    WH->>WH: Verify signature
    WH->>WH: Extract repo/branch

    alt Auto-run enabled
        WH->>CM: Trigger cloud run
        CM->>A: Start agent
        A-->>CM: Results
        CM-->>GH: Create comment/PR
    else Manual trigger
        WH->>DB: Store webhook payload
        WH-->>GH: 200 OK
    end
```

## OAuth Flow (GitHub/Slack/Notion)

### Platform OAuth (Telegram/Slack)

```mermaid
sequenceDiagram
    participant U as User
    participant P as Platform (TG/Slack)
    participant S as service.ts
    participant O as OAuth Handler
    participant DB as Database
    participant PR as Provider (GitHub/Slack)

    U->>P: /connect command
    P->>S: Initiate OAuth
    S->>O: generateState()
    O->>DB: Store state + identityId
    O-->>P: Auth URL
    P-->>U: Open auth URL

    U->>PR: Authorize
    PR->>S: Callback with code
    S->>O: Verify state
    O->>PR: Exchange code for token
    PR-->>O: Access token
    O->>DB: Store connection

    O-->>U: Success message
    O-->>P: Connection established
```

### HTTP OAuth (WebSocket/Cloud UI)

```mermaid
sequenceDiagram
    participant C as Client
    participant GHR as githubRoutes
    participant O as OAuth Handler
    participant DB as Database
    participant GH as GitHub

    C->>GHR: POST /api/github/oauth/start
    GHR->>O: generateState(source: "http")
    O->>DB: Store state + identityId
    GHR-->>C: {"authUrl": "https://github.com/..."}

    C->>GH: User authorizes in browser
    GH->>GHR: Callback with code
    GHR->>O: Verify state
    O->>GH: Exchange code for token
    GH-->>O: Access token
    O->>DB: Store connection + MCP token
    O-->>C: Redirect to success page
```

### GitHub App → OAuth Chaining

```mermaid
sequenceDiagram
    participant U as User
    participant GH as GitHub
    participant S as HTTP Server
    participant GA as githubApp
    participant O as OAuth Handler
    participant DB as Database

    U->>GH: Install GitHub App
    GH->>S: App callback (installation_id)
    S->>GA: handleInstallation()
    GA->>DB: Store App connection

    Note over S, O: Chain OAuth for MCP token
    S->>O: generateState(chain: true)
    S-->>U: Redirect to GitHub OAuth
    U->>GH: Authorize OAuth
    GH->>S: OAuth callback
    S->>O: Exchange code for token
    O->>DB: Store OAuth connection + MCP token
    O-->>U: Setup complete
```

## WebSocket Tool Call/Output Streaming Flow

```mermaid
sequenceDiagram
    participant CLI as Agent CLI
    participant JL as JSONL File
    participant JS as JsonlStreamer
    participant EM as EventMappers
    participant MSG as SessionMessenger
    participant WS as WebSocket
    participant P as Platform (TG/Slack)

    CLI->>JL: Write tool_use event
    JS->>JL: pollOnce() - read new lines
    JL-->>JS: JSONL events

    JS->>EM: mapToFragment()
    EM-->>JS: StreamFragment (tool_call)

    JS->>MSG: sendToSession()

    alt Has WebSocket subscribers
        MSG->>WS: {"type": "tool_call", "name": "Bash", ...}
    end

    MSG->>P: Format as text for TG/Slack

    CLI->>JL: Write tool_result event
    JS->>JL: pollOnce()
    JS->>EM: mapToFragment()
    EM-->>JS: StreamFragment (tool_output)

    JS->>MSG: sendToSession()

    alt Has WebSocket subscribers
        MSG->>WS: {"type": "tool_output", "content": "..."}
    end

    MSG->>P: Format as text for TG/Slack
```

## Progress Event Extraction Flow

```mermaid
sequenceDiagram
    participant CLI as Agent CLI
    participant JL as JSONL File
    participant JS as JsonlStreamer
    participant EM as EventMappers
    participant PE as progress/extractors
    participant MSG as SessionMessenger
    participant WS as WebSocket
    participant P as Platform (TG/Slack)

    CLI->>JL: Write JSONL event

    JS->>JL: pollOnce() - read new lines
    JL-->>JS: JSONL object

    par Parallel Pipelines
        JS->>EM: mapToFragment()
        EM-->>JS: StreamFragment[]
    and
        JS->>PE: extractProgress(agent, obj)
        PE-->>JS: ProgressEvent[]
    end

    Note over JS, MSG: StreamFragments → all platforms

    JS->>MSG: sendToSession(text/tool_call/tool_output)
    MSG->>WS: WebSocket message
    MSG->>P: Telegram/Slack message

    Note over JS, MSG: ProgressEvents → WebSocket only

    JS->>MSG: sendToSession({type: "progress_event"})
    MSG->>MSG: Early return for progress_event
    MSG->>WS: {"type": "progress_event", "event": {...}}
    Note over P: Telegram/Slack never receives progress events
```

## Progress Timeline Replay (HTTP)

```mermaid
sequenceDiagram
    participant C as Client
    participant AGR as agentRoutes
    participant DB as Database
    participant JL as JSONL Files
    participant PE as progress/extractors

    C->>AGR: GET /api/cloud/agent/progress-timeline
    AGR->>DB: Query session agent type
    AGR->>DB: listSessionOffsets(sessionId)
    DB-->>AGR: JSONL file paths

    loop Each JSONL file
        AGR->>JL: Read file content
        loop Each line
            AGR->>PE: extractProgress(agent, obj)
            PE-->>AGR: ProgressEvent[]
        end
    end

    AGR-->>C: {"sessionId", "agent", "events": [...]}
```

## Message Verbosity Levels

```mermaid
graph LR
    A[User Message] --> B{Verbosity Level}

    B -->|minimal| C[Essential outputs only]
    B -->|normal| D[Standard output]
    B -->|verbose| E[Full output + debug]

    C --> F[StreamFragment]
    D --> F
    E --> F

    F --> G[Messenger]
    G --> H[Platform]
```

## Language Flow

```mermaid
graph TD
    A[User Message] --> B{Identity Language?}
    B -->|en| C[English]
    B -->|zh| D[Chinese]
    B -->|null| E[Use user preference]

    C --> F[EnvironmentBuilder.withLanguage]
    D --> F
    E --> F

    F --> G[LANG environment variable]
    G --> H[Agent Process]
    H --> I[Response in configured language]
```
