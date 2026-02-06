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

## 设计方案

### 1. 协议变更

#### 移除的消息类型

```typescript
// Client → Server
cloud_run
cloud_follow_up
cloud_stop
subscribe_run
chat_connect

// Server → Client
chat_info
chat_history
```

#### 新增/修改的消息类型

**Client → Server:**

```typescript
interface ChatMessage {
  type: 'chat';
  chatId: string;           // Website 生成，类似 TG 的 chat_id
  prompt: string;           // 用户输入
  repoIds?: string[];       // 可选，首次时指定仓库
  agent?: 'codex' | 'claude_code';  // 可选，首次时指定
  restoreSnapshotId?: string;       // 可选，恢复快照
}

interface StopMessage {
  type: 'stop';
  chatId: string;           // 停止该 chat 的活跃 session
}

interface SubscribeMessage {
  type: 'subscribe';
  chatId: string;           // 订阅该 chat 的活跃 session
}
```

**Server → Client:**

```typescript
// Session 生命周期
{ type: 'session_started', sessionId, runId, chatId }
{ type: 'run_status', chatId, status, message }
{ type: 'run_links', chatId, previewUrl?, vscodeUrl? }
{ type: 'done', chatId }

// 流式输出
{ type: 'chunk', chatId, content }
{ type: 'tool_call', chatId, name, input }
{ type: 'tool_output', chatId, content }
```

### 2. 服务端处理逻辑

```typescript
async handleChat(connId, chatId, prompt, opts) {
  // 1. 查找该 chatId 的活跃 session
  const session = await getLatestSessionForChat('websocket', chatId, ['starting', 'running']);

  if (session) {
    // 2a. 有活跃 session → 发送 follow-up
    await sendFollowUp(session, prompt);
  } else {
    // 2b. 检查是否有已完成的 session 可恢复
    const finishedSession = await getLatestSessionForChat('websocket', chatId, ['finished', 'error']);

    if (finishedSession) {
      const snapshotId = await detectSnapshotForSession(finishedSession.id);
      await startNewSession({ chatId, prompt, restoreSnapshotId: snapshotId });
    } else {
      // 2c. 完全新的 session
      await startNewSession({ chatId, prompt, ...opts });
    }
  }
}
```

#### Session 状态与行为映射

| Session 状态 | 行为 |
|-------------|------|
| 不存在 | 创建新 session |
| `starting` / `running` | 发送 follow-up |
| `finished` / `error` | 恢复 session（使用最新 snapshot） |
| `killed` | 创建新 session |

### 3. 移除的模块

#### 数据库变更

```sql
-- 删除 chats 表
DROP TABLE chats;

-- 删除 sessions 表的 multi_chat_id 字段
ALTER TABLE sessions DROP COLUMN multi_chat_id;

-- 保留 chat_id 字段，用于存储 Website 传入的 chatId
```

#### 删除的文件

| 路径 | 说明 |
|------|------|
| `src/runtime/chat/` | 整个目录（types.ts, store.ts, service.ts, index.ts） |
| `src/runtime/service/http/chatRoutes.ts` | Chat HTTP API |
| `src/runtime/websocket/services/chatSession.ts` | ChatSessionService |

#### 需要修改的文件

| 文件 | 变更 |
|------|------|
| `websocket/handler.ts` | 移除 `chat_connect` 处理，新增 `chat`、`stop`、`subscribe` 处理 |
| `websocket/types.ts` | 移除旧消息类型，新增新消息类型 |
| `websocket/services/cloud.ts` | 重构，合并 cloud_run 和 follow_up 逻辑 |
| `store.ts` | 移除 `getSessionsByMultiChatId` |
| `sessionManager.ts` | 移除 `multiChatId` 参数 |
| `cloud/manager.ts` | 移除 `multiChatId` 参数 |
| `service.ts` | 移除 chatRoutes 注册 |

### 4. 完整消息协议

#### Client → Server

| 消息 | 字段 | 说明 |
|------|------|------|
| `auth` | `token` | 认证 |
| `chat` | `chatId`, `prompt`, `repoIds?`, `agent?` | 发送消息 |
| `stop` | `chatId` | 停止活跃 session |
| `subscribe` | `chatId` | 订阅活跃 session 的输出 |
| `list_runs` | `limit?` | 获取 run 历史 |
| `list_repos` | `provider?`, `search?` | 获取仓库列表 |
| `start_oauth` | `provider` | 开始 OAuth |
| `github_disconnect` | ... | 断开 GitHub |

#### Server → Client

| 消息 | 字段 | 说明 |
|------|------|------|
| `auth_ok` | `identityId` | 认证成功 |
| `auth_error` | `message` | 认证失败 |
| `session_started` | `sessionId`, `runId`, `chatId` | Session 已启动 |
| `run_status` | `chatId`, `status`, `message` | 状态更新 |
| `run_links` | `chatId`, `previewUrl?`, `vscodeUrl?` | 链接信息 |
| `chunk` | `chatId`, `content` | 流式文本 |
| `tool_call` | `chatId`, `name`, `input` | 工具调用 |
| `tool_output` | `chatId`, `content` | 工具输出 |
| `done` | `chatId` | 完成 |
| `error` | `code`, `message` | 错误 |
| `runs_list` | `runs` | Run 历史列表 |

### 5. 消息流程示例

```
Client                          Server
  │                               │
  │─── auth { token } ───────────▶│
  │◀── auth_ok ───────────────────│
  │                               │
  │─── chat { chatId, prompt } ──▶│  (首次消息)
  │◀── run_status { preparing } ──│
  │◀── session_started ───────────│
  │◀── run_links ─────────────────│
  │◀── chunk ─────────────────────│
  │◀── tool_call ─────────────────│
  │◀── tool_output ───────────────│
  │◀── chunk ─────────────────────│
  │◀── done ──────────────────────│
  │                               │
  │─── chat { chatId, prompt2 } ─▶│  (follow-up)
  │◀── chunk ─────────────────────│
  │◀── done ──────────────────────│
  │                               │
  │─── stop { chatId } ──────────▶│  (停止)
  │◀── done ──────────────────────│
```

### 6. 实现注意事项

#### 向后兼容性

采用不兼容方案：Website 和 Tintin 同时发布，旧协议直接移除。

#### Session 查找逻辑变更

- **当前**：`chat_id` = `ws:${identityId}`，按用户分组
- **变更后**：`chat_id` = Website 传入的 chatId（UUID），按 chat 分组

#### 数据迁移

不迁移，旧的 WebSocket sessions 保留，新 session 用新格式。

#### Migration 文件

新增 `0027_remove_chats.ts`：
- 删除 `chats` 表
- 删除 `multi_chat_id` 字段和索引

### 7. 测试重点

1. `chat` 消息 - 新建 session
2. `chat` 消息 - follow-up 到活跃 session
3. `chat` 消息 - 自动恢复已完成的 session
4. `stop` - 停止活跃 session
5. `subscribe` - 重连订阅
6. 错误处理 - 无活跃 session 时的 stop/subscribe
