# 消息处理层重构方案

> 基于代码审查和架构分析，对 Telegram/Slack/WebSocket 三平台消息处理流程进行统一重构。
>
> **原则**：不改变业务逻辑，遵循软件工程学和代码整洁之道，移除冗余代码。

---

## 一、当前架构分析

### 1.1 现状架构图

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              当前架构 (问题版)                                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────────┐  │
│  │    Telegram     │  │      Slack      │  │          WebSocket              │  │
│  │   Long-polling  │  │     Webhook     │  │        Full-duplex              │  │
│  └────────┬────────┘  └────────┬────────┘  └───────────────┬─────────────────┘  │
│           │                    │                           │                    │
│           ▼                    ▼                           ▼                    │
│  ┌─────────────────────────────────────────┐    ┌─────────────────────────────┐ │
│  │            service.ts                   │    │     WebSocketHandler        │ │
│  │  - HTTP Server                          │    │  - Message routing          │ │
│  │  - Bot initialization                   │    │  - Auth verification        │ │
│  │  - TaskQueue(16)                        │    └─────────────┬───────────────┘ │
│  └─────────────────┬───────────────────────┘                  │                 │
│                    │                                          │                 │
│                    ▼                                          ▼                 │
│  ┌─────────────────────────────────────────┐    ┌─────────────────────────────┐ │
│  │         BotController (367行)           │    │    ChatService (352行)      │ │
│  │  ┌─────────────────────────────────┐    │    │  ┌───────────────────────┐  │ │
│  │  │ handleSessionMessage()          │◄───┼────┼──│ 重复实现会话逻辑       │  │ │
│  │  │ - 消息队列判断                   │    │    │  │ - findActiveSession   │  │ │
│  │  │ - 云端/本地路由                  │    │    │  │ - sendFollowUp        │  │ │
│  │  │ - resumeCloudSession            │    │    │  │ - startOrResumeSession│  │ │
│  │  └─────────────────────────────────┘    │    │  └───────────────────────┘  │ │
│  │                                         │    │                             │ │
│  │  ┌─────────────────────────────────┐    │    │  直接调用 CloudManager      │ │
│  │  │ 注入 4 个 Handler               │    │    │  ⚠️ 绕过 BotController      │ │
│  │  └─────────────────────────────────┘    │    └─────────────┬───────────────┘ │
│  └─────────────────┬───────────────────────┘                  │                 │
│                    │                                          │                 │
│     ┌──────────────┼──────────────┐                          │                 │
│     │              │              │                          │                 │
│     ▼              ▼              ▼                          │                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐                  │                 │
│  │Telegram  │ │ Slack    │ │ Cloud        │                  │                 │
│  │Handler   │ │ Handler  │ │ Handler      │                  │                 │
│  │(1138行)  │ │ (512行)  │ │ (1573行)     │                  │                 │
│  └────┬─────┘ └────┬─────┘ └──────┬───────┘                  │                 │
│       │            │              │                          │                 │
│       │   ⚠️ 重复代码             │                          │                 │
│       │   - 交互解析              │                          │                 │
│       │   - UI 构建               │                          │                 │
│       │   - 权限检查              │                          │                 │
│       │            │              │                          │                 │
│       └────────────┴──────────────┴──────────────────────────┘                 │
│                                   │                                             │
│                    ┌──────────────┴──────────────┐                             │
│                    │                             │                             │
│                    ▼                             ▼                             │
│          ┌─────────────────┐          ┌─────────────────┐                      │
│          │ SessionManager  │          │  CloudManager   │                      │
│          │   (本地执行)     │          │   (云端执行)    │                      │
│          └─────────────────┘          └─────────────────┘                      │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 当前业务流程图

#### Telegram 消息处理流程

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        Telegram 消息处理流程                                  │
└──────────────────────────────────────────────────────────────────────────────┘

  用户消息
      │
      ▼
┌─────────────┐
│ getUpdates  │ ← Long-polling
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ TaskQueue(16)   │ ← 并发控制
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│ BotController.handleTelegramUpdate()    │
└────────────────────┬────────────────────┘
                     │
         ┌───────────┴───────────┬─────────────────┐
         │                       │                 │
         ▼                       ▼                 ▼
┌─────────────────┐    ┌─────────────────┐   ┌──────────────┐
│ callback_query  │    │    message      │   │  其他类型    │
│ (按钮点击)       │    │   (文本消息)    │   │              │
└────────┬────────┘    └────────┬────────┘   └──────────────┘
         │                      │
         ▼                      ▼
┌─────────────────┐    ┌─────────────────────────────────────┐
│ parseTelegram   │    │ TelegramHandler.handleTelegramMsg() │
│ InteractionActn │    └────────────────────┬────────────────┘
└────────┬────────┘                         │
         │                    ┌─────────────┼─────────────┐
         ▼                    │             │             │
┌─────────────────┐           ▼             ▼             ▼
│ handleShared    │    ┌───────────┐ ┌───────────┐ ┌───────────┐
│ InteractionActn │    │ /cloud    │ │ /settings │ │ 普通消息   │
└────────┬────────┘    │ 命令      │ │ 命令      │ │           │
         │             └─────┬─────┘ └───────────┘ └─────┬─────┘
         │                   │                           │
         │                   ▼                           │
         │           ┌───────────────┐                   │
         │           │ CloudHandler  │                   │
         │           │ handleCloud   │                   │
         │           │ Command()     │                   │
         │           └───────┬───────┘                   │
         │                   │                           │
         └───────────────────┴───────────────────────────┘
                             │
                             ▼
              ┌──────────────────────────────┐
              │ BotController.               │
              │ handleSessionMessage()       │
              └──────────────┬───────────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
              ▼                             ▼
    ┌─────────────────┐          ┌──────────────────┐
    │ status=running? │          │ cloud enabled?   │
    │ → 队列消息      │          │ → resumeCloud    │
    └─────────────────┘          │ → 或本地 resume  │
                                 └──────────────────┘
```

#### WebSocket 消息处理流程

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        WebSocket 消息处理流程                                 │
└──────────────────────────────────────────────────────────────────────────────┘

  客户端消息 { type: 'chat', chatId, prompt, repoIds }
      │
      ▼
┌─────────────────────────────────────────┐
│ WebSocketHandler.handleMessage()        │
└────────────────────┬────────────────────┘
                     │
         ┌───────────┴───────────┬────────────────┐
         │                       │                │
         ▼                       ▼                ▼
┌─────────────────┐    ┌─────────────────┐  ┌──────────────┐
│ type: 'auth'    │    │ type: 'chat'   │  │ type: 'stop' │
└────────┬────────┘    └────────┬────────┘  └──────┬───────┘
         │                      │                  │
         ▼                      ▼                  ▼
┌─────────────────┐    ┌─────────────────────────────────────┐
│ handleAuth()    │    │ ChatService.handleChat()            │
│ - Token验证     │    │ ⚠️ 独立实现，不走 BotController      │
│ - 匿名身份      │    └────────────────────┬────────────────┘
└─────────────────┘                         │
                                            │
                             ┌──────────────┴──────────────┐
                             │                             │
                             ▼                             ▼
                   ┌─────────────────┐          ┌──────────────────┐
                   │ findActiveSessn │          │ startOrResume    │
                   │ → sendFollowUp  │          │ Session()        │
                   └─────────────────┘          └────────┬─────────┘
                                                         │
                                                         ▼
                                              ┌──────────────────┐
                                              │ CloudManager     │
                                              │ .startRun()      │
                                              │ ⚠️ 直接调用       │
                                              └──────────────────┘
```

### 1.3 代码审查发现的问题

#### 问题汇总表

| 类型 | 问题 | 位置 | 影响 | 优先级 |
|------|------|------|------|--------|
| **重复代码** | 交互操作解析 | `telegramHandler:209-241` vs `slackHandler:497-511` | 维护困难 | P1 |
| **重复代码** | UI 构建逻辑 | `cloudHandler:109-173` vs `telegramHandler:195-207` | 不一致风险 | P1 |
| **重复代码** | 会话查询逻辑 | 三个平台都调用 `getLatestSessionForChat()` | 冗余 | P2 |
| **职责混乱** | BotController 过度中心化 | `controller2.ts` 367行 | 难以测试 | P1 |
| **职责混乱** | CloudHandler 职责过重 | `cloudHandler.ts` 1573行 | 难以维护 | P2 |
| **职责混乱** | ChatService 混合职责 | `chat.ts` 352行 | 与 BotController 重复 | P1 |
| **架构问题** | WebSocket 绕过 BotController | `handler.ts` → `ChatService` | 流程不一致 | P1 |
| **架构问题** | 权限验证分散 | 各 handler 独立实现 | 安全风险 | P2 |

#### 重复代码详情

**1. 交互操作解析 (完全重复)**

```typescript
// telegramHandler.ts:209-241
parseTelegramInteractionAction(data: string): SharedInteractionAction | null {
  if (data.startsWith("lang:")) { /* ... */ }
  if (data.startsWith("kill:")) { /* ... */ }
  if (data.startsWith("review:")) { /* ... */ }
  if (data.startsWith("commit:")) { /* ... */ }
  // ...
}

// slackHandler.ts:497-511 - 相同逻辑
parseSlackInteractionAction(actionId: string, value: string): SharedInteractionAction | null {
  if (actionId === "change_language") { /* ... */ }
  if (actionId === "kill_session") { /* ... */ }
  // ...
}
```

**2. UI 构建 (重复实现)**

```typescript
// cloudHandler.ts:109-127
private buildRunActionTelegramKeyboard(...) {
  const rows = [
    [{ text: t("button.stop", lang), callback_data: `kill:${sessionId}` }],
    // ...
  ];
}

// telegramHandler.ts:195-207 - 另一个版本
buildRunActionTelegramKeyboard(...) {
  // 几乎相同的实现
}
```

**3. 会话处理逻辑 (业务重复)**

```typescript
// controller2.ts:324-366
private async handleSessionMessage(session, userId, text) {
  if (session.status === "running" || session.status === "starting") {
    await enqueuePendingMessage(...);
    return;
  }
  if (this.cloudManager && this.config.cloud?.enabled) {
    const resumed = await this.cloudManager.resumeCloudSession(session, text);
    // ...
  }
  await this.sessionManager.resumeSession(session, text);
}

// chat.ts:102-127 - ChatService 中的重复实现
private async sendFollowUp(connId, chatId, session, prompt) {
  const resumed = await this.cloudManager.resumeCloudSession(session, prompt);
  if (resumed === 'resumed') { /* ... */ }
  // ...
}
```

---

## 二、目标架构设计

### 2.1 目标架构图

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              目标架构 (重构后)                                   │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────────┐  │
│  │    Telegram     │  │      Slack      │  │          WebSocket              │  │
│  └────────┬────────┘  └────────┬────────┘  └───────────────┬─────────────────┘  │
│           │                    │                           │                    │
│           ▼                    ▼                           ▼                    │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                        Platform Adapters (薄层)                          │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐   │   │
│  │  │ TelegramAdapter │  │  SlackAdapter   │  │   WebSocketAdapter      │   │   │
│  │  │  (~300行)       │  │   (~250行)      │  │    (~200行)             │   │   │
│  │  │                 │  │                 │  │                         │   │   │
│  │  │ - 协议解析      │  │ - 协议解析      │  │ - 协议解析 (已结构化)   │   │   │
│  │  │ - 权限检查      │  │ - Workspace     │  │ - Sandbox 上下文        │   │   │
│  │  │ - 命令解析      │  │ - 命令解析      │  │ - WS 订阅              │   │   │
│  │  │ - 响应格式化    │  │ - Block Kit     │  │ - 响应格式化           │   │   │
│  │  └────────┬────────┘  └────────┬────────┘  └────────────┬────────────┘   │   │
│  └───────────┼────────────────────┼────────────────────────┼────────────────┘   │
│              │                    │                        │                    │
│              │     ChatRequest    │                        │                    │
│              └────────────────────┼────────────────────────┘                    │
│                                   │                                             │
│                                   ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                     SessionOrchestrator (~400行)                         │   │
│  │                                                                          │   │
│  │  ┌────────────────────────────────────────────────────────────────────┐  │   │
│  │  │ handleChat(request: ChatRequest): Promise<ChatResult>              │  │   │
│  │  │                                                                    │  │   │
│  │  │ 1. findActiveSession(chatId, platform)                            │  │   │
│  │  │ 2. if active → handleFollowUp()                                   │  │   │
│  │  │    - running/starting → queuePendingMessage()                     │  │   │
│  │  │    - finished → resumeCloudSession() or restartCloudSession()     │  │   │
│  │  │ 3. else → startNewSession()                                       │  │   │
│  │  │    - detectSnapshot()                                             │  │   │
│  │  │    - cloudManager.startRun() or sessionManager.startNew()         │  │   │
│  │  └────────────────────────────────────────────────────────────────────┘  │   │
│  │                                                                          │   │
│  │  ┌────────────────────────────────────────────────────────────────────┐  │   │
│  │  │ handleAction(action: SessionAction): Promise<ActionResult>         │  │   │
│  │  │                                                                    │  │   │
│  │  │ - stop  → killSession()                                           │  │   │
│  │  │ - review → resumeSession(REVIEW_PROMPT)                           │  │   │
│  │  │ - commit → resumeSession(COMMIT_PROMPT)                           │  │   │
│  │  └────────────────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────┬────────────────────────────────────┘   │
│                                        │                                        │
│                         ┌──────────────┴──────────────┐                        │
│                         │                             │                        │
│                         ▼                             ▼                        │
│               ┌─────────────────┐          ┌─────────────────┐                 │
│               │ SessionManager  │          │  CloudManager   │                 │
│               │   (本地执行)     │          │   (云端执行)    │                 │
│               │                 │          │                 │                 │
│               │ - spawn CLI     │          │ - Modal sandbox │                 │
│               │ - monitor JSONL │          │ - snapshot      │                 │
│               │ - process mgmt  │          │ - resume/restart│                 │
│               └─────────────────┘          └─────────────────┘                 │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                          共享服务层                                       │   │
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐  ┌───────────┐  │   │
│  │  │ CommandParser │  │ ActionParser  │  │ AccessControl │  │ UIBuilder │  │   │
│  │  │ - /cloud      │  │ - kill:xxx    │  │ - allowlist   │  │ - TG键盘  │  │   │
│  │  │ - /settings   │  │ - review:xxx  │  │ - workspace   │  │ - Slack块 │  │   │
│  │  │ - 普通消息    │  │ - commit:xxx  │  │ - token验证   │  │           │  │   │
│  │  └───────────────┘  └───────────────┘  └───────────────┘  └───────────┘  │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                          流式输出层 (保持现有)                            │   │
│  │                                                                          │   │
│  │  Streamer → SessionMessenger → TelegramSender / SlackSender / WSBroadcast│   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 目标业务流程图 (统一)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        统一消息处理流程 (重构后)                               │
└──────────────────────────────────────────────────────────────────────────────┘

  平台消息 (Telegram/Slack/WebSocket)
      │
      ▼
┌─────────────────────────────────────────┐
│         Platform Adapter                │
│                                         │
│  1. 解析平台特定格式                      │
│  2. 权限检查 (AccessControl)             │
│  3. 解析命令/操作 (CommandParser/ActionParser) │
│  4. 解析身份 (IdentityResolver)          │
│  5. 构造 ChatRequest / SessionAction    │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│         SessionOrchestrator             │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │ handleChat(request)             │    │
│  │                                 │    │
│  │  chatId + platform              │    │
│  │         │                       │    │
│  │         ▼                       │    │
│  │  ┌─────────────────┐            │    │
│  │  │findActiveSession│            │    │
│  │  └────────┬────────┘            │    │
│  │           │                     │    │
│  │     ┌─────┴─────┐               │    │
│  │     │           │               │    │
│  │     ▼           ▼               │    │
│  │  有活跃会话   无活跃会话          │    │
│  │     │           │               │    │
│  │     ▼           ▼               │    │
│  │  ┌──────┐   ┌──────────┐        │    │
│  │  │Follow│   │startNew  │        │    │
│  │  │Up    │   │Session   │        │    │
│  │  └──┬───┘   └────┬─────┘        │    │
│  │     │            │              │    │
│  │     ▼            ▼              │    │
│  │  running?    detectSnapshot     │    │
│  │     │            │              │    │
│  │  ┌──┴───┐        │              │    │
│  │  │      │        │              │    │
│  │  ▼      ▼        ▼              │    │
│  │ queue  resume  startRun         │    │
│  │ Msg    Cloud   (cloud/local)    │    │
│  │        Session                  │    │
│  └─────────────────────────────────┘    │
│                                         │
│  返回 ChatResult:                       │
│  { sessionId, action, cdpUrl? }        │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│         Platform Adapter                │
│                                         │
│  6. 格式化响应 (UIBuilder)              │
│  7. 发送确认消息                         │
│  8. 订阅会话 (WebSocket)                │
└─────────────────────────────────────────┘
                     │
                     │ (并行)
                     ▼
┌─────────────────────────────────────────┐
│         流式输出                         │
│                                         │
│  Streamer 解析 JSONL                    │
│         │                               │
│         ▼                               │
│  SessionMessenger.sendToSession()       │
│         │                               │
│         ├─→ Telegram: editMessage       │
│         ├─→ Slack: chat.update          │
│         └─→ WebSocket: broadcast        │
└─────────────────────────────────────────┘
```

### 2.3 模块依赖图 (重构后)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           模块依赖关系 (重构后)                               │
└─────────────────────────────────────────────────────────────────────────────┘

                              ┌─────────────┐
                              │   service   │
                              │    .ts      │
                              └──────┬──────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
              ▼                      ▼                      ▼
    ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
    │TelegramAdapter  │    │  SlackAdapter   │    │WebSocketAdapter │
    └────────┬────────┘    └────────┬────────┘    └────────┬────────┘
             │                      │                      │
             │         依赖         │                      │
             │    ┌─────────────────┼──────────────────────┘
             │    │                 │
             ▼    ▼                 ▼
    ┌──────────────────────────────────────────────────────────────┐
    │                     共享服务层                                 │
    │  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐       │
    │  │ CommandParser │ │ ActionParser  │ │ AccessControl │       │
    │  └───────────────┘ └───────────────┘ └───────────────┘       │
    │  ┌───────────────┐ ┌───────────────┐                         │
    │  │IdentityResolvr│ │   UIBuilder   │                         │
    │  └───────────────┘ └───────────────┘                         │
    └──────────────────────────────┬───────────────────────────────┘
                                   │
                                   ▼
                      ┌─────────────────────────┐
                      │   SessionOrchestrator   │
                      └────────────┬────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │                             │
                    ▼                             ▼
          ┌─────────────────┐          ┌─────────────────┐
          │ SessionManager  │          │  CloudManager   │
          └─────────────────┘          └─────────────────┘

特点：
- 无循环依赖
- 清晰的分层
- 单向依赖流
```

---

## 三、文件变更清单

### 3.1 新增文件

| 文件路径 | 职责 | 预估行数 |
|---------|------|---------|
| `src/runtime/orchestrator/index.ts` | 导出 | 10 |
| `src/runtime/orchestrator/types.ts` | 类型定义 | 80 |
| `src/runtime/orchestrator/SessionOrchestrator.ts` | 核心编排 | 400 |
| `src/runtime/adapters/index.ts` | 导出 | 10 |
| `src/runtime/adapters/TelegramAdapter.ts` | Telegram 适配 | 300 |
| `src/runtime/adapters/SlackAdapter.ts` | Slack 适配 | 250 |
| `src/runtime/adapters/WebSocketAdapter.ts` | WebSocket 适配 | 200 |
| `src/runtime/shared/index.ts` | 导出 | 10 |
| `src/runtime/shared/CommandParser.ts` | 命令解析 | 150 |
| `src/runtime/shared/ActionParser.ts` | 操作解析 | 100 |
| `src/runtime/shared/AccessControl.ts` | 权限控制 | 120 |
| `src/runtime/shared/UIBuilder.ts` | UI 构建 | 200 |
| `src/runtime/shared/IdentityResolver.ts` | 身份解析 | 80 |

**新增总计**: 13 个文件, ~1910 行

### 3.2 删除文件

| 文件路径 | 原因 | 原行数 |
|---------|------|--------|
| `src/runtime/websocket/services/chat.ts` | 逻辑移到 WebSocketAdapter + Orchestrator | 352 |
| `src/runtime/websocket/services/identity.ts` | 合并到 shared/IdentityResolver.ts | 50 |

**删除总计**: 2 个文件, ~402 行

### 3.3 重大修改文件

| 文件路径 | 修改内容 | 原行数 → 目标行数 |
|---------|---------|------------------|
| `src/runtime/controller2.ts` | 移除业务逻辑，仅保留协调代码 | 367 → 150 |
| `src/runtime/controller/telegramHandler.ts` | 移除命令处理，保留平台特定逻辑 | 1138 → 400 |
| `src/runtime/controller/slackHandler.ts` | 移除命令处理，保留平台特定逻辑 | 512 → 200 |
| `src/runtime/controller/cloudHandler.ts` | 移除重复UI构建，保留云命令处理 | 1573 → 800 |
| `src/runtime/controller/interactionHandler.ts` | 使用 ActionParser，简化逻辑 | 估计减少 100 行 |
| `src/runtime/websocket/handler.ts` | 简化为消息路由，委托给 Adapter | 303 → 150 |
| `src/runtime/websocket/services/index.ts` | 移除 ChatService 导出 | 微调 |
| `src/runtime/service.ts` | 初始化 Adapters 和 Orchestrator | 微调 |

**修改总计**: 8 个文件, 减少约 1900 行

### 3.4 代码变化统计

| 指标 | 数值 |
|------|------|
| 新增文件 | 13 |
| 删除文件 | 2 |
| 修改文件 | 8 |
| 新增代码 | ~1910 行 |
| 删除代码 | ~2300 行 |
| **净减少** | **~390 行** |
| **重复代码消除** | ~350 行 |

---

## 四、核心类型定义

### 4.1 ChatRequest (统一请求)

```typescript
// src/runtime/orchestrator/types.ts

export interface ChatRequest {
  // === 必需字段 ===
  identityId: string;
  chatId: string;
  prompt: string;
  platform: 'telegram' | 'slack' | 'websocket';

  // === 平台上下文 ===
  workspaceId?: string | null;
  spaceId?: string | null;
  userId?: string;

  // === 执行参数 ===
  repoIds?: string[];
  agent?: 'codex' | 'claude_code';
  restoreSnapshotId?: string;

  // === WebSocket 特有 ===
  sandbox?: {
    workspaceId: string;
    rootPath: string;
  };
}

export interface ChatResult {
  sessionId: string;
  action: 'started' | 'resumed' | 'queued' | 'restarted';
  cdpUrl?: string;
  liveViewUrl?: string;
  message?: string;
}

export type SessionAction =
  | { type: 'stop'; sessionId: string }
  | { type: 'review'; sessionId: string }
  | { type: 'commit'; sessionId: string; branchRule?: string };

export interface ActionResult {
  success: boolean;
  message?: string;
}
```

### 4.2 Adapter 接口

```typescript
// src/runtime/adapters/types.ts

export interface PlatformAdapter {
  /** 处理入站消息 */
  handleInbound(raw: unknown): Promise<void>;

  /** 处理交互操作 (按钮点击等) */
  handleInteraction?(raw: unknown): Promise<void>;
}

export interface AdapterDeps {
  orchestrator: SessionOrchestrator;
  commandParser: CommandParser;
  actionParser: ActionParser;
  accessControl: AccessControl;
  identityResolver: IdentityResolver;
  uiBuilder: UIBuilder;
  logger: Logger;
}
```

### 4.3 共享服务接口

```typescript
// src/runtime/shared/types.ts

export interface CommandParser {
  parse(text: string): ParsedCommand;
}

export interface ParsedCommand {
  type: 'chat' | 'cloud' | 'settings' | 'list' | 'help';
  prompt: string;
  repoIds?: string[];
  agent?: 'codex' | 'claude_code';
  settings?: Record<string, string>;
}

export interface ActionParser {
  /** 从 Telegram callback_data 解析 */
  parseFromTelegram(data: string): SessionAction | null;

  /** 从 Slack action_id + value 解析 */
  parseFromSlack(actionId: string, value: string): SessionAction | null;
}

export interface AccessControl {
  checkTelegram(chatId: string, userId: string): Promise<AccessDecision>;
  checkSlack(workspaceId: string | null, channelId: string, userId: string): Promise<AccessDecision>;
  checkWebSocket(token: string | undefined): Promise<AccessDecision>;
}

export interface AccessDecision {
  allowed: boolean;
  reason?: string;
  identityId?: string;
}

export interface UIBuilder {
  buildTelegramKeyboard(opts: RunActionOpts): TelegramInlineKeyboard;
  buildSlackBlocks(opts: RunActionOpts): SlackBlock[];
}

export interface RunActionOpts {
  sessionId: string;
  runId?: string;
  lang: UserLanguage;
  viewUrl?: string;
  vscodeUrl?: string;
  includeStop?: boolean;
  includeReview?: boolean;
  includeCommit?: boolean;
}
```

---

## 五、实施步骤

### Phase 1: 创建共享服务层 (Day 1)

1. 创建 `src/runtime/shared/` 目录
2. 实现 `CommandParser` - 从 `controller/commands.ts` 提取
3. 实现 `ActionParser` - 合并 `parseTelegramInteractionAction` 和 `parseSlackInteractionAction`
4. 实现 `AccessControl` - 合并 `telegramAccessDecision` 和 `slackAccessDecision`
5. 实现 `UIBuilder` - 合并 `buildRunActionTelegramKeyboard` 和 `buildRunActionSlackBlocks`
6. 实现 `IdentityResolver` - 从 `websocket/services/identity.ts` 提取并扩展

### Phase 2: 创建 SessionOrchestrator (Day 2)

1. 创建 `src/runtime/orchestrator/` 目录
2. 定义类型 `types.ts`
3. 实现 `SessionOrchestrator` - 从 `controller2.handleSessionMessage` 提取核心逻辑
4. 添加 `handleAction` 方法 - 统一处理 stop/review/commit

### Phase 3: 创建 Adapters (Day 3-4)

1. 创建 `src/runtime/adapters/` 目录
2. 实现 `WebSocketAdapter` - 从 `ChatService` 迁移
3. 删除 `websocket/services/chat.ts` 和 `identity.ts`
4. 实现 `TelegramAdapter` - 从 `TelegramHandler` 提取
5. 实现 `SlackAdapter` - 从 `SlackHandler` 提取

### Phase 4: 精简现有代码 (Day 5)

1. 精简 `controller2.ts` - 移除已迁移逻辑
2. 精简 `telegramHandler.ts` - 移除命令处理
3. 精简 `slackHandler.ts` - 移除命令处理
4. 精简 `cloudHandler.ts` - 移除重复 UI 构建
5. 精简 `websocket/handler.ts` - 委托给 WebSocketAdapter

### Phase 5: 集成测试 (Day 6)

1. 运行现有测试，确保不破坏功能
2. 添加 Orchestrator 单元测试
3. 添加 Adapter 集成测试
4. 端到端测试三个平台

---

## 六、风险评估

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| 重构影响现有功能 | 高 | 中 | 分阶段实施，每阶段全量测试 |
| CloudHandler 修改引发问题 | 高 | 中 | CloudHandler 最后精简，保守修改 |
| WebSocket 流程变化 | 中 | 低 | WebSocket 相对独立，风险可控 |
| 团队适应新结构 | 低 | 低 | 文档清晰，代码评审 |

---

## 七、验收标准

1. **功能不变**: 三个平台的用户体验完全一致
2. **代码减少**: 总代码量减少 10%+
3. **重复消除**: 无平台间重复的业务逻辑
4. **测试覆盖**: Orchestrator 核心逻辑 80%+ 覆盖率
5. **文档完整**: 新架构文档和 API 说明

---

## 八、附录：现有代码行数统计

| 文件 | 行数 | 备注 |
|------|------|------|
| controller2.ts | 367 | 待精简 |
| controller/telegramHandler.ts | 1138 | 待精简 |
| controller/slackHandler.ts | 512 | 待精简 |
| controller/cloudHandler.ts | 1573 | 待精简 |
| controller/interactionHandler.ts | ~400 | 待精简 |
| controller/commands.ts | ~300 | 提取到 CommandParser |
| controller/settings.ts | 468 | 保持不变 |
| websocket/handler.ts | 303 | 待精简 |
| websocket/services/chat.ts | 352 | 删除 |
| websocket/services/identity.ts | ~50 | 删除 |
| **总计** | **~5463** | **目标减少 ~800-1000 行** |
