# Session Orchestrator 统一架构设计

## 背景

当前 Tintin 的三个平台 (Telegram, Slack, WebSocket) 存在消息处理流程不一致的问题：

- **Telegram/Slack**: 消息 → BotController → handlers → SessionManager
- **WebSocket**: 消息 → WebSocketHandler → ChatService → CloudManager (绕过 BotController)

这导致：
1. 业务逻辑重复 (ChatService 重新实现了部分 BotController 逻辑)
2. 能力不对等 (WebSocket 只支持云端执行)
3. 测试覆盖困难 (两条路径需要分别测试)
4. 新功能需要多处实现

## 设计目标

采用六边形架构 (Ports & Adapters) 思想：
- **统一核心业务逻辑** - SessionOrchestrator
- **分离平台适配器** - TelegramAdapter, SlackAdapter, WebSocketAdapter

## 核心接口设计

### SessionOrchestrator

```typescript
// src/runtime/orchestrator/types.ts

/** 平台无关的聊天请求 */
export interface ChatRequest {
  // === 必需字段 ===
  identityId: string;          // DB identity ID (已解析)
  chatId: string;              // 对话标识
  prompt: string;              // 用户输入

  // === 平台上下文 ===
  platform: 'telegram' | 'slack' | 'websocket';
  workspaceId?: string | null; // Slack workspace
  spaceId?: string | null;     // Telegram topic/thread
  userId?: string;             // 原始平台用户 ID

  // === 执行参数 ===
  repoIds?: string[];          // 关联仓库
  agent?: 'codex' | 'claude_code';
  restoreSnapshotId?: string;  // 显式指定快照

  // === 扩展上下文 ===
  sandbox?: {                  // WebSocket 连接级沙箱
    workspaceId: string;
    rootPath: string;
  };
}

/** 统一的聊天响应 */
export interface ChatResult {
  sessionId: string;
  action: 'started' | 'resumed' | 'queued' | 'restarted';
  cdpUrl?: string;             // 浏览器会话
  liveViewUrl?: string;
  message?: string;            // 可选的用户提示
}

/** Session 操作动作 */
export type SessionAction =
  | { type: 'stop'; sessionId: string }
  | { type: 'review'; sessionId: string }
  | { type: 'commit'; sessionId: string; branchRule?: string };

/** 操作结果 */
export interface ActionResult {
  success: boolean;
  message?: string;
}

/** 核心编排接口 */
export interface SessionOrchestrator {
  /** 处理聊天请求 - 统一入口 */
  handleChat(request: ChatRequest): Promise<ChatResult>;

  /** 处理 Session 操作 (Stop/Review/Commit) */
  handleAction(action: SessionAction): Promise<ActionResult>;

  /** 查询会话状态 */
  getSessionStatus(chatId: string): Promise<SessionStatus | null>;
}
```

### 核心实现

```typescript
// src/runtime/orchestrator/SessionOrchestrator.ts

export class SessionOrchestratorImpl implements SessionOrchestrator {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly sessionManager: SessionManager,   // 本地执行
    private readonly cloudManager: CloudManager | null, // 云端执行
  ) {}

  async handleChat(request: ChatRequest): Promise<ChatResult> {
    const { chatId, prompt } = request;

    // 1. 查找活跃会话
    const activeSession = await this.findActiveSession(chatId, request.platform);

    if (activeSession) {
      // 2a. 活跃会话 → 处理后续消息
      return this.handleFollowUp(activeSession, request);
    }

    // 2b. 无活跃会话 → 启动新会话
    return this.startNewSession(request);
  }

  private async handleFollowUp(
    session: SessionRow,
    request: ChatRequest,
  ): Promise<ChatResult> {
    const { prompt } = request;

    // 会话正在运行 → 队列消息
    if (session.status === 'running' || session.status === 'starting') {
      await this.queuePendingMessage(session.id, request.userId, prompt);
      return { sessionId: session.id, action: 'queued' };
    }

    // 会话已结束 → 尝试恢复
    if (this.isCloudEnabled() && this.cloudManager) {
      const resumed = await this.cloudManager.resumeCloudSession(session, prompt);

      if (resumed === 'resumed') {
        return { sessionId: session.id, action: 'resumed' };
      }

      if (resumed === 'expired') {
        await this.cloudManager.restartCloudSession(session, prompt);
        return { sessionId: session.id, action: 'restarted' };
      }
    }

    // 本地执行
    await this.sessionManager.resumeSession(session, prompt);
    return { sessionId: session.id, action: 'resumed' };
  }

  private async startNewSession(request: ChatRequest): Promise<ChatResult> {
    const {
      identityId,
      chatId,
      prompt,
      platform,
      repoIds = [],
      agent,
      sandbox,
      restoreSnapshotId,
    } = request;

    const isPlayground = repoIds.length === 0;
    const resolvedAgent = agent ?? this.getDefaultAgent();

    // 云端执行
    if (this.isCloudEnabled() && this.cloudManager) {
      const snapshotId = restoreSnapshotId ?? await this.detectSnapshot(chatId, identityId);

      const result = sandbox
        ? await this.cloudManager.startRunWithWorkspace({
            workspace: { id: sandbox.workspaceId, rootPath: sandbox.rootPath },
            identityId,
            platform,
            chatId,
            prompt,
            repoIds,
            agent: resolvedAgent,
            playground: isPlayground,
            restoreSnapshotId: snapshotId,
          })
        : await this.cloudManager.startRun({
            identityId,
            platform,
            chatId,
            prompt,
            repoIds,
            agent: resolvedAgent,
            playground: isPlayground,
            restoreSnapshotId: snapshotId,
          });

      return {
        sessionId: result.sessionId,
        action: 'started',
        cdpUrl: result.cdpUrl ?? undefined,
        liveViewUrl: this.cloudManager.getLiveViewUrl(result.sessionId) ?? undefined,
      };
    }

    // 本地执行
    const session = await this.sessionManager.startNew({
      platform,
      chatId,
      spaceId: request.spaceId ?? null,
      userId: request.userId ?? identityId,
      prompt,
      agent: resolvedAgent,
    });

    return { sessionId: session.id, action: 'started' };
  }

  async handleAction(action: SessionAction): Promise<ActionResult> {
    switch (action.type) {
      case 'stop':
        return this.handleStop(action.sessionId);
      case 'review':
        return this.handleReview(action.sessionId);
      case 'commit':
        return this.handleCommit(action.sessionId, action.branchRule);
    }
  }

  // ... 辅助方法
}
```

## 平台适配器设计

### 适配器职责

| 职责 | 说明 |
|------|------|
| 协议解析 | 解析平台特定消息格式 (Telegram Update, Slack Event, WS JSON) |
| 权限检查 | 平台特定的访问控制 (allowlist, workspace 验证) |
| 命令解析 | 文本命令 → ChatRequest (可选，使用共享 CommandParser) |
| 身份解析 | 平台 userId → DB identityId |
| 响应格式化 | ChatResult → 平台特定格式 (Inline keyboard, Block kit, JSON) |

### TelegramAdapter

```typescript
// src/runtime/adapters/TelegramAdapter.ts

export class TelegramAdapter {
  constructor(
    private readonly orchestrator: SessionOrchestrator,
    private readonly identityResolver: IdentityResolver,
    private readonly commandParser: CommandParser,
    private readonly telegram: TelegramClient,
  ) {}

  async handleMessage(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.text) return;

    const chatId = String(message.chat.id);
    const userId = String(message.from.id);
    const spaceId = this.resolveSpaceId(message);

    // 权限检查
    const access = await this.checkAccess(chatId, userId);
    if (!access.allowed) return;

    // 解析命令
    const parsed = this.commandParser.parse(message.text);

    // 解析身份
    const identityId = await this.identityResolver.resolve('telegram', userId);

    // 调用 Orchestrator
    const result = await this.orchestrator.handleChat({
      identityId,
      chatId,
      prompt: parsed.prompt,
      platform: 'telegram',
      spaceId,
      userId,
      repoIds: parsed.repoIds,
      agent: parsed.agent,
    });

    // 发送确认
    await this.sendConfirmation(chatId, result, spaceId);
  }

  async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const action = this.parseCallbackData(query.data);
    if (!action) return;

    const result = await this.orchestrator.handleAction(action);
    await this.answerCallback(query.id, result);
  }
}
```

### WebSocketAdapter

```typescript
// src/runtime/adapters/WebSocketAdapter.ts

export class WebSocketAdapter {
  constructor(
    private readonly orchestrator: SessionOrchestrator,
    private readonly identityResolver: IdentityResolver,
    private readonly wsManager: WebSocketManager,
    private readonly sandboxService: SandboxLifecycleService | null,
  ) {}

  async handleChat(connId: string, message: ChatMessage): Promise<void> {
    const conn = this.wsManager.getConnection(connId);
    if (!conn?.identityId) return;

    // 解析身份
    const identityId = await this.identityResolver.resolve(conn.identityId);

    // 获取沙箱上下文
    const sandbox = this.sandboxService?.getSandbox(connId);

    // 调用 Orchestrator (WebSocket 消息已结构化，无需解析)
    const result = await this.orchestrator.handleChat({
      identityId,
      chatId: message.chatId,
      prompt: message.prompt,
      platform: 'websocket',
      repoIds: message.repoIds,
      agent: message.agent,
      restoreSnapshotId: message.restoreSnapshotId,
      sandbox: sandbox
        ? { workspaceId: sandbox.workspaceId, rootPath: sandbox.rootPath }
        : undefined,
    });

    // 订阅会话
    this.wsManager.subscribeToSession(connId, result.sessionId);

    // WebSocket 特定响应
    if (result.cdpUrl) {
      this.wsManager.sendToConnection(connId, {
        type: 'browser_session',
        sessionId: result.sessionId,
        cdpUrl: result.cdpUrl,
        liveViewUrl: result.liveViewUrl,
      });
    }
  }

  async handleStop(connId: string, message: StopMessage): Promise<void> {
    const result = await this.orchestrator.handleAction({
      type: 'stop',
      sessionId: message.sessionId,
    });

    this.wsManager.sendToConnection(connId, {
      type: 'action_result',
      success: result.success,
      message: result.message,
    });
  }
}
```

## 响应推送设计

### 双层模式

| 类型 | 处理方式 | 示例 |
|------|---------|------|
| **一次性响应** | Orchestrator 返回 → Adapter 推送 | "Session started", 按钮响应 |
| **流式输出** | 事件订阅 (保持现有 sendToSession 模式) | JSONL 事件流, 工具输出 |

### 架构图

```
┌─────────────────────────────────────────────────────────────┐
│  Orchestrator                                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ handleChat() → ChatResult (一次性)                   │    │
│  └─────────────────────────────────────────────────────┘    │
└───────────────────────────────┬─────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────┐
│  Adapter                                                    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ sendConfirmation(result) → Telegram/Slack/WS        │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘

                    ====== 流式输出 (并行) ======

┌─────────────────────────────────────────────────────────────┐
│  Streamer (JSONL 解析)                                      │
│         │                                                   │
│         ▼                                                   │
│  SessionMessenger (订阅模式，保持现有)                        │
│         │                                                   │
│         ├─→ TelegramSender                                  │
│         ├─→ SlackSender                                     │
│         └─→ WebSocketBroadcaster                            │
└─────────────────────────────────────────────────────────────┘
```

## 命令解析设计

### 共享 CommandParser

```typescript
// src/runtime/commands/CommandParser.ts

export interface ParsedCommand {
  type: 'chat' | 'cloud' | 'settings' | 'list';
  prompt: string;
  repoIds?: string[];
  agent?: 'codex' | 'claude_code';
  settings?: Record<string, string>;
}

export class CommandParser {
  parse(text: string): ParsedCommand {
    // /cloud repo:xxx prompt
    if (text.startsWith('/cloud')) {
      return this.parseCloudCommand(text);
    }

    // /settings lang:zh
    if (text.startsWith('/settings')) {
      return this.parseSettingsCommand(text);
    }

    // 普通聊天
    return { type: 'chat', prompt: text };
  }
}
```

### 使用方式

- **Telegram/Slack**: 使用 CommandParser 解析文本命令
- **WebSocket**: 已结构化，直接使用

## 文件结构变化

```
src/runtime/
├── orchestrator/                  # 新增：核心编排层
│   ├── index.ts
│   ├── types.ts                   # ChatRequest, ChatResult, SessionAction
│   ├── SessionOrchestrator.ts     # 核心实现
│   └── IdentityResolver.ts        # 统一的身份解析
│
├── adapters/                      # 新增：平台适配器
│   ├── index.ts
│   ├── TelegramAdapter.ts
│   ├── SlackAdapter.ts
│   └── WebSocketAdapter.ts
│
├── commands/                      # 新增：命令解析
│   ├── index.ts
│   └── CommandParser.ts
│
├── sessionManager.ts              # 保留：本地进程管理
├── cloud/manager.ts               # 保留：云端沙箱管理
│
├── controller2.ts                 # 精简：移除业务逻辑
├── controller/                    # 逐步迁移到 adapters/
│
└── websocket/
    ├── handler.ts                 # 精简：消息路由 → WebSocketAdapter
    └── services/
        ├── chat.ts                # 删除：逻辑移到 WebSocketAdapter
        └── sandboxLifecycle.ts    # 保留
```

## 重构后架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                      Platform Adapters (薄层)                    │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────────┐   │
│  │TelegramAdapter│  │ SlackAdapter  │  │ WebSocketAdapter  │   │
│  │               │  │               │  │                   │   │
│  │ - 解析 Update │  │ - 解析 Event  │  │ - 解析 JSON       │   │
│  │ - 访问控制    │  │ - Workspace   │  │ - Sandbox 上下文  │   │
│  │ - 响应格式化  │  │ - Block Kit   │  │ - WS 订阅        │   │
│  └───────┬───────┘  └───────┬───────┘  └─────────┬─────────┘   │
│          │                  │                    │              │
└──────────┼──────────────────┼────────────────────┼──────────────┘
           │                  │                    │
           │    ChatRequest   │                    │
           └──────────────────┼────────────────────┘
                              │
                              ▼
           ┌──────────────────────────────────────────┐
           │          SessionOrchestrator             │
           │                                          │
           │  handleChat(request: ChatRequest)        │
           │  handleAction(action: SessionAction)     │
           │  ┌────────────────────────────────────┐  │
           │  │ 统一的业务决策:                     │  │
           │  │ - 消息队列 vs 立即执行              │  │
           │  │ - 本地 vs 云端路由                 │  │
           │  │ - 快照检测和恢复                   │  │
           │  │ - Agent 选择                      │  │
           │  └────────────────────────────────────┘  │
           └─────────────────┬────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
              ▼                             ▼
    ┌─────────────────┐          ┌─────────────────┐
    │ SessionManager  │          │  CloudManager   │
    │   (本地执行)     │          │   (云端执行)    │
    └─────────────────┘          └─────────────────┘
```

## 收益

| 方面 | 改进 |
|------|------|
| **代码复用** | 核心逻辑统一，消除 ChatService 与 BotController 的重复 |
| **测试效率** | 核心逻辑一次测试，Adapter 只测协议转换 |
| **一致性** | 三个平台行为保证一致 |
| **扩展性** | 新平台只需实现薄薄的 Adapter |
| **可维护性** | 职责清晰，改动影响范围可控 |

## 实施建议

1. **Phase 1**: 创建 `orchestrator/` 模块，提取 `handleSessionMessage` 逻辑
2. **Phase 2**: 创建 `WebSocketAdapter`，从 `ChatService` 迁移
3. **Phase 3**: 创建 `TelegramAdapter` 和 `SlackAdapter`，从 handlers 迁移
4. **Phase 4**: 精简 `controller2.ts`，删除已迁移代码
