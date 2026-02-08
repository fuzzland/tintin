# WebSocket Adapter + Orchestrator 迁移设计

## 目标

将 WebSocket 的 chat/stop/subscribe 逻辑迁移到 Adapter + Orchestrator 架构，保留 WebSocketHandler 作为薄路由层，仅处理 auth/GitHub/list_runs 等非会话业务。行为采用“会话忙时排队”（方案 1）。

## 范围

- 迁移 `chat`/`stop`/`subscribe` 到新架构路径。
- 仍保留 `GitHubService`、`GitHubDisconnectService` 等在 `WebSocketHandler` 中。
- 不改动协议字段与消息格式。

## 方案选择

采用“会话忙时排队（Queue-on-busy）”方案：
- 当会话 running/starting 时，调用 `SessionOrchestrator.handleSessionMessage` 进行排队。
- 当会话 finished/error 时，交由 orchestrator 触发 resume/restart。
- 保持 stop/subscribe 语义与现状一致。

## 架构与数据流

1. `WebSocketHandler` 解析消息类型与鉴权。
2. `chat/stop/subscribe` 委托给 `WebSocketChatOrchestrator`。
3. `WebSocketChatOrchestrator` 使用 `SessionOrchestrator` 处理会话消息，使用 `WebSocketAdapter` 发送 run_status/done/browser_session。
4. 新会话启动仍通过 `CloudManager.startRun/startRunWithWorkspace`。

## 关键行为

- **chat**
  - 校验 chatId/prompt；检查 sandbox 状态。
  - 若存在 active session：订阅 session → 调用 `SessionOrchestrator` → 回写 run_status。
  - 若无 active session：按现有逻辑启动云运行 → 订阅 session → 发送 browser_session。
- **stop**
  - 校验归属后调用 `CloudManager.stopCloudRun`，广播 done。
- **subscribe**
  - 订阅 session，并推送当前 run_status。

## 变更点

- 新增 `src/runtime/orchestrator/WebSocketChatOrchestrator.ts`。
- `src/runtime/websocket/handler.ts` 改为调用新 orchestrator + adapter。
- `ChatService` 不再被入口使用（保留文件但不再依赖）。

## 风险与兼容

- follow-up 行为由“直接 resume”调整为“排队”；需确保 UI 对 run_status 更新容忍。
- 协议字段与消息格式保持不变。

## 测试建议

- 现有 WebSocketAdapter 测试继续通过。
- 手工验证：
  - chat 建新会话 → run_status(preparing) → browser_session → chunk/done。
  - 会话运行中再次 chat → queued 提示。
  - stop → done(stopped=true)。
  - subscribe → run_status。
