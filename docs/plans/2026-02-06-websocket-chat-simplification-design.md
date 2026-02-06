# WebSocket Chat 简化设计

## 概述

将 WebSocket 的 chat 处理逻辑简化为与 Telegram 一致的模式：
- 移除 `chats` 表和相关服务
- 统一使用 `chatId` 进行消息路由
- Website 自行管理对话历史

## 背景

当前 Tintin 有两套 chat 处理逻辑：
1. **TG/Slack 模式**：平台管理对话历史，Tintin 只存储 `chat_id` 用于路由
2. **WebSocket 模式**：Tintin 管理 `chats` 表、提供 HTTP API 和 WebSocket 消息

这导致了不必要的复杂性。Website 应该和 TG 一样自行管理对话历史。

---

## 架构图

### 当前架构（Before）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              WebSocket Layer                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────────┐ │
│  │   handler.ts    │    │    types.ts     │    │      services/          │ │
│  │                 │    │                 │    │                         │ │
│  │ • cloud_run     │───▶│ CloudRunMessage │───▶│ ┌─────────────────────┐ │ │
│  │ • cloud_follow  │    │ CloudFollowUp   │    │ │  CloudRunService    │ │ │
│  │ • cloud_stop    │    │ CloudStopMsg    │    │ │  ┌───────────────┐  │ │ │
│  │ • subscribe_run │    │ SubscribeRunMsg │    │ │  │handleCloudRun │  │ │ │
│  │ • chat_connect  │    │ ChatConnectMsg  │    │ │  │handleFollowUp │  │ │ │
│  │                 │    │                 │    │ │  │handleStop     │  │ │ │
│  └─────────────────┘    └─────────────────┘    │ │  │handleSubscribe│  │ │ │
│                                                 │ │  └───────────────┘  │ │ │
│                                                 │ └─────────────────────┘ │ │
│                                                 │                         │ │
│                                                 │ ┌─────────────────────┐ │ │
│                                                 │ │ ChatSessionService  │ │ │
│                                                 │ │ (chat_connect)      │ │ │
│                                                 │ └──────────┬──────────┘ │ │
│                                                 └────────────┼────────────┘ │
└──────────────────────────────────────────────────────────────┼──────────────┘
                                                               │
                                                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Chat Layer (移除)                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────────┐    ┌───────────────────┐    ┌───────────────────┐   │
│  │   chat/types.ts   │    │  chat/service.ts  │    │   chat/store.ts   │   │
│  │                   │    │                   │    │                   │   │
│  │ • Chat            │◀───│ • ChatService     │───▶│ • insertChat      │   │
│  │ • ChatMessage     │    │   - createChat    │    │ • selectChatById  │   │
│  │ • ChatDetail      │    │   - listChats     │    │ • updateSnapshot  │   │
│  │ • CreateChatInput │    │   - getChat       │    │ • deleteChatById  │   │
│  └───────────────────┘    │   - deleteChat    │    └───────────────────┘   │
│                           └───────────────────┘                             │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                    chatRoutes.ts (HTTP API)                            │ │
│  │  POST /api/chats  │  GET /api/chats  │  GET /api/chats/:id  │ DELETE  │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Database Layer                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────┐    ┌─────────────────────────────────────┐│
│  │        chats 表 (移除)       │    │           sessions 表               ││
│  │                             │    │                                     ││
│  │ • id                        │    │ • id                                ││
│  │ • identity_id               │◀───│ • chat_id (平台 chat ID)            ││
│  │ • title                     │    │ • multi_chat_id (移除)  ────────────┼│
│  │ • repo_id                   │    │ • platform                          ││
│  │ • initial_prompt            │    │ • status                            ││
│  │ • last_snapshot_id          │    │ • ...                               ││
│  │ • status                    │    │                                     ││
│  └─────────────────────────────┘    └─────────────────────────────────────┘│
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 目标架构（After）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              WebSocket Layer                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────────┐ │
│  │   handler.ts    │    │    types.ts     │    │      services/          │ │
│  │                 │    │                 │    │                         │ │
│  │ • chat ─────────│───▶│ ChatMessage     │───▶│ ┌─────────────────────┐ │ │
│  │ • stop ─────────│───▶│ StopMessage     │───▶│ │    ChatService      │ │ │
│  │ • subscribe ────│───▶│ SubscribeMsg    │───▶│ │  (原 CloudRunSvc)   │ │ │
│  │                 │    │                 │    │ │                     │ │ │
│  │                 │    │                 │    │ │  ┌───────────────┐  │ │ │
│  │                 │    │                 │    │ │  │ handleChat    │  │ │ │
│  │                 │    │                 │    │ │  │ handleStop    │  │ │ │
│  │                 │    │                 │    │ │  │ handleSubscr  │  │ │ │
│  └─────────────────┘    └─────────────────┘    │ │  └───────────────┘  │ │ │
│                                                 │ └─────────────────────┘ │ │
│                                                 └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Database Layer                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                           sessions 表                                   ││
│  │                                                                         ││
│  │ • id                                                                    ││
│  │ • chat_id  ◀─── Website 传入的 chatId（类似 TG 的 chat_id）             ││
│  │ • platform                                                              ││
│  │ • status                                                                ││
│  │ • ...                                                                   ││
│  │                                                                         ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 业务流程图

### 消息处理流程（chat 消息）

```
                                ┌─────────────┐
                                │   Client    │
                                │  (Website)  │
                                └──────┬──────┘
                                       │
                     chat { chatId, prompt, repoIds?, agent? }
                                       │
                                       ▼
                          ┌────────────────────────┐
                          │    WebSocket Handler   │
                          │      handleChat()      │
                          └───────────┬────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────┐
                    │  getLatestSessionForChat(chatId)    │
                    │  查找活跃 session (starting/running) │
                    └─────────────────┬───────────────────┘
                                      │
                         ┌────────────┴────────────┐
                         │                         │
                    找到活跃 session           未找到活跃 session
                         │                         │
                         ▼                         ▼
              ┌──────────────────┐    ┌────────────────────────────┐
              │  sendFollowUp()  │    │ 查找已完成 session          │
              │  发送到活跃进程   │    │ (finished/error)           │
              └────────┬─────────┘    └─────────────┬──────────────┘
                       │                            │
                       │               ┌────────────┴────────────┐
                       │               │                         │
                       │          找到已完成 session         未找到
                       │               │                         │
                       │               ▼                         ▼
                       │    ┌──────────────────────┐   ┌─────────────────┐
                       │    │ detectSnapshotFor    │   │ startNewSession │
                       │    │ Session()            │   │ 创建全新 session │
                       │    └──────────┬───────────┘   └────────┬────────┘
                       │               │                        │
                       │    ┌──────────┴──────────┐             │
                       │    │                     │             │
                       │  有 snapshot         无 snapshot       │
                       │    │                     │             │
                       │    ▼                     ▼             │
                       │  ┌─────────────┐  ┌─────────────┐      │
                       │  │恢复 snapshot │  │创建新 session│      │
                       │  │创建新 session│  └──────┬──────┘      │
                       │  └──────┬──────┘         │             │
                       │         │                │             │
                       └─────────┴────────────────┴─────────────┘
                                          │
                                          ▼
                               ┌──────────────────┐
                               │  流式输出响应     │
                               │  chunk/tool_call │
                               │  tool_output/done│
                               └──────────────────┘
```

### Session 状态流转图

```
                                   ┌─────────────┐
                                   │    chat     │
                                   │   消息进入   │
                                   └──────┬──────┘
                                          │
                                          ▼
                          ┌───────────────────────────────┐
                          │     查询 session 状态         │
                          └───────────────┬───────────────┘
                                          │
            ┌─────────────┬───────────────┼───────────────┬─────────────┐
            │             │               │               │             │
            ▼             ▼               ▼               ▼             ▼
      ┌──────────┐  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
      │ 不存在   │  │ starting │   │ running  │   │ finished │   │  killed  │
      │          │  │ /running │   │          │   │ /error   │   │          │
      └────┬─────┘  └────┬─────┘   └────┬─────┘   └────┬─────┘   └────┬─────┘
           │             │              │              │              │
           ▼             ▼              ▼              ▼              ▼
      ┌──────────┐  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
      │创建新    │  │发送       │   │发送       │   │恢复       │   │创建新    │
      │session   │  │follow-up │   │follow-up │   │session   │   │session   │
      │          │  │(队列)     │   │(直接)     │   │(snapshot)│   │          │
      └──────────┘  └──────────┘   └──────────┘   └──────────┘   └──────────┘
```

### 与 TG 模式对比

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Telegram 模式                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────┐      ┌──────────────┐      ┌──────────────┐                  │
│  │ Telegram │ ───▶ │ TG Handler   │ ───▶ │ Session      │                  │
│  │ Message  │      │ chat_id 来自 │      │ Manager      │                  │
│  │ chat_id  │      │ TG 消息       │      │ chat_id 存储 │                  │
│  └──────────┘      └──────────────┘      └──────────────┘                  │
│                                                                             │
│  对话历史由 Telegram 管理                                                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                              WebSocket 模式 (新)                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────┐      ┌──────────────┐      ┌──────────────┐                  │
│  │ Website  │ ───▶ │ WS Handler   │ ───▶ │ Session      │                  │
│  │ 生成     │      │ chatId 来自  │      │ Manager      │                  │
│  │ chatId   │      │ 客户端消息    │      │ chat_id 存储 │                  │
│  └──────────┘      └──────────────┘      └──────────────┘                  │
│                                                                             │
│  对话历史由 Website 管理                                                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 代码审查与优化

### 1. CloudRunService 重构

**当前问题：**
- `handleCloudRun` 和 `handleCloudFollowUp` 有大量重复逻辑
- 方法过长（handleCloudRun: 200+ 行）
- 职责不清晰：既处理新建又处理恢复

**优化建议：**

```typescript
// 重构前：分散的处理方法
class CloudRunService {
  handleCloudRun()      // 200+ 行
  handleCloudFollowUp() // 100+ 行
  handleCloudStop()     // 50+ 行
  handleSubscribeRun()  // 40+ 行
}

// 重构后：统一的 ChatService
class ChatService {
  // 单一入口，内部路由
  async handleChat(connId: string, message: ChatMessage): Promise<void> {
    const session = await this.findActiveSession(message.chatId);

    if (session) {
      await this.sendFollowUp(session, message.prompt);
    } else {
      await this.startOrResumeSession(connId, message);
    }
  }

  // 提取公共逻辑
  private async findActiveSession(chatId: string): Promise<SessionRow | null> {
    return getLatestSessionForChat(this.db, 'websocket', chatId, ['starting', 'running']);
  }

  private async startOrResumeSession(connId: string, message: ChatMessage): Promise<void> {
    const finishedSession = await this.findFinishedSession(message.chatId);

    if (finishedSession) {
      await this.resumeSession(connId, finishedSession, message);
    } else {
      await this.createNewSession(connId, message);
    }
  }
}
```

### 2. 移除冗余代码

**需要删除的文件：**

| 文件 | 行数 | 说明 |
|------|------|------|
| `chat/types.ts` | ~70 | Chat 类型定义 |
| `chat/store.ts` | ~120 | Chat CRUD 操作 |
| `chat/service.ts` | ~110 | ChatService |
| `chat/index.ts` | ~5 | 导出 |
| `service/http/chatRoutes.ts` | ~190 | HTTP API |
| `websocket/services/chatSession.ts` | ~120 | WebSocket 处理 |
| **合计** | **~615** | **移除约 615 行代码** |

**需要删除的函数：**

| 文件 | 函数 | 说明 |
|------|------|------|
| `store.ts` | `getSessionsByMultiChatId` | 不再需要 |

### 3. 类型定义优化

**当前问题：** `types.ts` 中存在 5 种相关消息类型

```typescript
// 当前：5 种消息类型
CloudRunMessage
CloudFollowUpMessage
CloudStopMessage
SubscribeRunMessage
ChatConnectMessage
```

**优化后：** 3 种简洁的消息类型

```typescript
// 优化后：3 种消息类型
interface ChatMessage {
  type: 'chat';
  chatId: string;
  prompt: string;
  repoIds?: string[];
  agent?: 'codex' | 'claude_code';
  restoreSnapshotId?: string;
}

interface StopMessage {
  type: 'stop';
  chatId: string;
}

interface SubscribeMessage {
  type: 'subscribe';
  chatId: string;
}
```

### 4. Handler 简化

**当前：** 8 个 case 分支处理 cloud/chat 相关消息

```typescript
// handler.ts 当前
switch (message.type) {
  case 'cloud_run': ...
  case 'subscribe_run': ...
  case 'cloud_follow_up': ...
  case 'cloud_stop': ...
  case 'chat_connect': ...
  // ...
}
```

**优化后：** 3 个 case 分支

```typescript
// handler.ts 优化后
switch (message.type) {
  case 'chat':
    await this.chatService.handleChat(connId, conn, message);
    break;
  case 'stop':
    await this.chatService.handleStop(connId, conn, message);
    break;
  case 'subscribe':
    await this.chatService.handleSubscribe(connId, conn, message);
    break;
  // ...
}
```

### 5. 响应消息统一

**当前问题：** 响应消息使用 `runId` 和 `sessionId` 混合

```typescript
// 当前：不一致的标识符
{ type: 'run_status', runId: '...' }
{ type: 'chunk', sessionId: '...' }
{ type: 'done', sessionId: '...' }
```

**优化后：** 统一使用 `chatId`

```typescript
// 优化后：一致的标识符
{ type: 'run_status', chatId: '...' }
{ type: 'chunk', chatId: '...' }
{ type: 'done', chatId: '...' }
```

### 6. 错误处理优化

**当前问题：** 重复的错误处理代码

```typescript
// 当前：每个方法都有类似的错误处理
this.wsManager.sendToConnection(connId, {
  type: 'error',
  code: ErrorCodes.INVALID_MESSAGE,
  message: 'Prompt is required',
});
```

**优化建议：** 提取错误处理工具函数

```typescript
// 优化后：统一的错误处理
private sendError(connId: string, code: ErrorCode, message: string): void {
  this.wsManager.sendToConnection(connId, { type: 'error', code, message });
}

// 使用
if (!prompt) {
  return this.sendError(connId, ErrorCodes.INVALID_MESSAGE, 'Prompt is required');
}
```

---

## 实现步骤

### Phase 1: 协议变更

1. 更新 `websocket/types.ts`
   - 新增 `ChatMessage`, `StopMessage`, `SubscribeMessage`
   - 移除 `CloudRunMessage`, `CloudFollowUpMessage`, `CloudStopMessage`, `SubscribeRunMessage`, `ChatConnectMessage`
   - 更新响应消息使用 `chatId`

2. 更新 `websocket/handler.ts`
   - 移除旧的 case 分支
   - 新增 `chat`, `stop`, `subscribe` 处理

### Phase 2: 服务重构

3. 重构 `websocket/services/cloud.ts` → `websocket/services/chat.ts`
   - 重命名为 `ChatService`
   - 合并 `handleCloudRun` 和 `handleCloudFollowUp` 为 `handleChat`
   - 用 `chatId` 替代 `runId` 进行路由
   - 优化错误处理

4. 删除 `websocket/services/chatSession.ts`

### Phase 3: 数据层清理

5. 新增 Migration `0027_remove_chats.ts`
   - 删除 `chats` 表
   - 删除 `multi_chat_id` 字段

6. 清理 `store.ts`
   - 删除 `getSessionsByMultiChatId`

7. 删除 `chat/` 目录

8. 删除 `service/http/chatRoutes.ts`

9. 更新 `service.ts`
   - 移除 chatRoutes 注册

### Phase 4: 集成测试

10. 更新相关测试文件
11. 端到端测试

---

## 测试重点

| 测试场景 | 预期行为 |
|----------|----------|
| `chat` 新建 session | 创建新 session，返回 `session_started` |
| `chat` follow-up 活跃 session | 发送到现有 session，继续流式输出 |
| `chat` 恢复已完成 session | 检测 snapshot，恢复工作区，创建新 session |
| `stop` 活跃 session | 停止 session，返回 `done` |
| `stop` 无活跃 session | 返回错误 |
| `subscribe` 活跃 session | 订阅成功，接收流式输出 |
| `subscribe` 无活跃 session | 返回错误 |

---

## 代码量变化预估

| 类别 | 行数变化 |
|------|----------|
| 删除文件 | -615 行 |
| 重构代码 | -200 行（合并重复逻辑） |
| 新增代码 | +50 行（新消息类型） |
| Migration | +20 行 |
| **净减少** | **约 745 行** |
