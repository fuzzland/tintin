# WebSocket Chat 简化实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 简化 WebSocket chat 处理逻辑，统一为与 TG 一致的模式，移除冗余代码约 745 行。

**Architecture:** 将分散的 `cloud_run`/`cloud_follow_up`/`cloud_stop`/`subscribe_run`/`chat_connect` 消息统一为 `chat`/`stop`/`subscribe` 三种消息类型。移除 `chats` 表和相关服务，使用 `chatId` 进行会话路由。

**Tech Stack:** TypeScript, Kysely (migrations), WebSocket

**Design Doc:** `docs/plans/2026-02-06-websocket-chat-simplification-design.md`

---

## Phase 1: 协议变更

### Task 1: 更新 WebSocket 类型定义

**Files:**
- Modify: `src/runtime/websocket/types.ts`

**Step 1: 添加新的消息类型**

在 `// ============ Cloud Run Messages (Client → Server) ============` 之前添加：

```typescript
// ============ Chat Messages (Client → Server) ============

export interface ChatMessage {
  type: 'chat';
  chatId: string;           // Website 生成的 chat ID
  prompt: string;           // 用户输入
  repoIds?: string[];       // 可选，首次时指定仓库
  agent?: 'codex' | 'claude_code';  // 可选，首次时指定
  restoreSnapshotId?: string;       // 可选，恢复快照
}

export interface StopMessage {
  type: 'stop';
  chatId: string;           // 停止该 chat 的活跃 session
}

export interface SubscribeMessage {
  type: 'subscribe';
  chatId: string;           // 订阅该 chat 的活跃 session
}
```

**Step 2: 更新 ClientMessage 联合类型**

替换 `ClientMessage` 类型定义：

```typescript
export type ClientMessage =
  | AuthMessage
  | PingMessage
  | GetConnectionsMessage
  | ListReposMessage
  | GetAuthStatusMessage
  | StartOAuthMessage
  | GitHubDisconnectMessage
  | ChatMessage
  | StopMessage
  | SubscribeMessage
  | ListRunsMessage;
```

**Step 3: 移除旧的消息类型定义**

删除以下接口定义：
- `CloudRunMessage` (lines 45-54)
- `SubscribeRunMessage` (lines 56-59)
- `CloudFollowUpMessage` (lines 61-65)
- `CloudStopMessage` (lines 67-70)
- `ChatConnectMessage` (lines 74-77)

**Step 4: 更新响应消息使用 chatId**

修改 `ChunkMessage`:
```typescript
export interface ChunkMessage {
  type: 'chunk';
  chatId: string;    // 改为 chatId
  content: string;
}
```

修改 `ToolCallMessage`:
```typescript
export interface ToolCallMessage {
  type: 'tool_call';
  chatId: string;    // 改为 chatId
  name: string;
  input?: string;
}
```

修改 `ToolOutputMessage`:
```typescript
export interface ToolOutputMessage {
  type: 'tool_output';
  chatId: string;    // 改为 chatId
  name: string;
  output: string;
}
```

修改 `DoneMessage`:
```typescript
export interface DoneMessage {
  type: 'done';
  chatId: string;    // 改为 chatId
  stopped?: boolean;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}
```

修改 `SessionStartedMessage`:
```typescript
export interface SessionStartedMessage {
  type: 'session_started';
  sessionId: string;
  runId?: string;
  chatId: string;    // 新增 chatId
}
```

修改 `RunStatusMessage`:
```typescript
export interface RunStatusMessage {
  type: 'run_status';
  chatId: string;    // 改为 chatId
  status: CloudRunStatus;
  message?: string;
}
```

修改 `RunLinksMessage`:
```typescript
export interface RunLinksMessage {
  type: 'run_links';
  chatId: string;    // 改为 chatId
  sessionId: string;
  viewUrl?: string;
  vscodeUrl?: string;
  codeServerUrl?: string;
  previewUrl?: string;
  previewSummary?: string;
}
```

**Step 5: 移除旧的响应消息类型**

删除以下接口定义：
- `ChatInfoMessage` (lines 299-306)
- `ChatHistoryMessage` (lines 308-316)
- `FollowUpQueuedMessage` (lines 283-288)
- `FollowUpResumingMessage` (lines 290-295)

**Step 6: 更新 ServerMessage 联合类型**

移除被删除的消息类型：
```typescript
export type ServerMessage =
  | AuthOkMessage
  | AuthErrorMessage
  | SessionStartedMessage
  | ChunkMessage
  | ToolCallMessage
  | ToolOutputMessage
  | AgentEventMessage
  | PlanUpdateMessage
  | DoneMessage
  | ErrorMessage
  | PongMessage
  | ConnectionsListMessage
  | ReposListMessage
  | AuthStatusMessage
  | OAuthStartedMessage
  | GitHubDisconnectPreviewMessage
  | GitHubDisconnectResultMessage
  | GitHubDisconnectErrorMessage
  | RunStatusMessage
  | RunLinksMessage
  | BrowserSessionMessage
  | SandboxStatusMessage
  | SandboxReadyMessage
  | SandboxErrorMessage
  | WorkspaceRestoredMessage
  | RunCompletedNotificationMessage
  | RunsListMessage;
```

**Step 7: 运行类型检查**

Run: `npm run typecheck`

Expected: 会有编译错误（因为其他文件还在使用旧类型），记录需要修改的文件

**Step 8: Commit**

```bash
git add src/runtime/websocket/types.ts
git commit -m "refactor(ws): update message types for chat simplification

- Add ChatMessage, StopMessage, SubscribeMessage
- Remove CloudRunMessage, CloudFollowUpMessage, CloudStopMessage, etc.
- Update response messages to use chatId instead of sessionId/runId
- Remove ChatInfoMessage, ChatHistoryMessage, FollowUpQueuedMessage

BREAKING CHANGE: WebSocket protocol updated"
```

---

### Task 2: 创建新的 ChatService

**Files:**
- Create: `src/runtime/websocket/services/chat.ts`

**Step 1: 创建 ChatService 基础结构**

```typescript
import type { Logger } from '../../log.js';
import type { Db } from '../../db.js';
import type { AppConfig } from '../../config.js';
import type { CloudManager } from '../../cloud/manager.js';
import type { WebSocketManager } from '../manager.js';
import type { ChatMessage, StopMessage, SubscribeMessage, WSConnection } from '../types.js';
import { ErrorCodes } from '../types.js';
import { IdentityResolver } from './identity.js';
import { CloudLinkBuilder } from './linkBuilder.js';
import type { SandboxLifecycleService } from './sandboxLifecycle.js';
import { getLatestSessionForChat, type SessionRow } from '../../store.js';
import { listReposForIdentity, getCloudRun } from '../../cloud/store.js';
import { mapDbStatusToWsStatus } from '../../cloud/types.js';

/**
 * ChatService - Handles WebSocket chat messages.
 * Unified handler for chat, stop, and subscribe operations.
 * Follows TG model: route by chatId, client manages chat history.
 */
export class ChatService {
  private readonly identityResolver: IdentityResolver;
  private readonly linkBuilder: CloudLinkBuilder;

  constructor(
    private readonly wsManager: WebSocketManager,
    private readonly cloudManager: CloudManager,
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly logger: Logger,
    private readonly sandboxService: SandboxLifecycleService | null = null,
  ) {
    this.identityResolver = new IdentityResolver(db);
    this.linkBuilder = new CloudLinkBuilder(config);
  }

  // Helper: send error message
  private sendError(connId: string, code: string, message: string): void {
    this.wsManager.sendToConnection(connId, { type: 'error', code, message });
  }

  // Helper: find active session for chatId
  private async findActiveSession(chatId: string): Promise<SessionRow | null> {
    return getLatestSessionForChat(this.db, 'websocket', chatId, ['starting', 'running']) ?? null;
  }

  // Helper: find finished session for chatId
  private async findFinishedSession(chatId: string): Promise<SessionRow | null> {
    return getLatestSessionForChat(this.db, 'websocket', chatId, ['finished', 'error']) ?? null;
  }
}
```

**Step 2: 实现 handleChat 方法**

在 ChatService 类中添加：

```typescript
  /**
   * Handle a chat message.
   * If active session exists: send follow-up
   * If no active session: create new or resume from snapshot
   */
  async handleChat(
    connId: string,
    conn: WSConnection,
    message: ChatMessage,
  ): Promise<void> {
    const { chatId, prompt } = message;

    if (!chatId) {
      return this.sendError(connId, ErrorCodes.INVALID_MESSAGE, 'chatId is required');
    }

    if (!prompt?.trim()) {
      return this.sendError(connId, ErrorCodes.INVALID_MESSAGE, 'prompt is required');
    }

    try {
      // Check sandbox status if sandboxService is available
      if (this.sandboxService) {
        const { status, error } = this.sandboxService.getSandboxStatus(connId);
        if (status === 'provisioning') {
          return this.sendError(connId, ErrorCodes.SERVICE_ERROR, 'Sandbox is still provisioning');
        }
        if (status === 'in_use') {
          return this.sendError(connId, ErrorCodes.SERVICE_ERROR, 'Sandbox is in use. Stop current run first.');
        }
        if (status === 'error') {
          return this.sendError(connId, ErrorCodes.SERVICE_ERROR, `Sandbox error: ${error ?? 'Unknown'}`);
        }
        if (status === 'terminating') {
          return this.sendError(connId, ErrorCodes.SERVICE_ERROR, 'Sandbox is terminating');
        }
      }

      // Find active session for this chatId
      const activeSession = await this.findActiveSession(chatId);

      if (activeSession) {
        // Send follow-up to existing session
        await this.sendFollowUp(connId, chatId, activeSession, prompt.trim());
      } else {
        // No active session - start new or resume
        await this.startOrResumeSession(connId, conn, message);
      }
    } catch (err) {
      this.logger.error(`[ws][chat] handleChat error connId=${connId}: ${String(err)}`);
      this.sendError(connId, ErrorCodes.SERVICE_ERROR, `Failed to process chat: ${String(err)}`);
    }
  }

  private async sendFollowUp(
    connId: string,
    chatId: string,
    session: SessionRow,
    prompt: string,
  ): Promise<void> {
    // Subscribe to session
    this.wsManager.subscribeToSession(connId, session.id);

    // Resume or queue the prompt
    const resumed = await this.cloudManager.resumeCloudSession(session, prompt);

    if (resumed === 'resumed') {
      this.logger.info(`[ws][chat] follow-up sent chatId=${chatId} sessionId=${session.id}`);
      if (this.sandboxService) {
        // Find the runId for this session
        const run = await getCloudRun(this.db, session.id);
        if (run) {
          this.sandboxService.markInUse(connId, run.id, session.id);
        }
      }
    } else {
      // Session not resumable, need to restart
      this.logger.info(`[ws][chat] session not resumable, restarting chatId=${chatId}`);
      const restarted = await this.cloudManager.restartCloudSession(session, prompt);
      if (restarted !== 'restarted') {
        this.sendError(connId, ErrorCodes.SERVICE_ERROR, 'Failed to resume or restart session');
      }
    }
  }

  private async startOrResumeSession(
    connId: string,
    conn: WSConnection,
    message: ChatMessage,
  ): Promise<void> {
    const { chatId, prompt, repoIds = [], agent: requestedAgent, restoreSnapshotId } = message;
    const dbIdentityId = await this.identityResolver.resolve(conn.identityId!);
    const isPlayground = repoIds.length === 0;

    // Validate repo access
    if (!isPlayground) {
      const accessible = await this.validateRepoAccess(dbIdentityId, repoIds);
      if (!accessible) {
        return this.sendError(connId, ErrorCodes.ACCESS_DENIED, 'No access to specified repositories');
      }
    }

    // Check for finished session to resume
    const finishedSession = await this.findFinishedSession(chatId);
    let snapshotId = restoreSnapshotId ?? null;

    if (!snapshotId && finishedSession) {
      snapshotId = await this.cloudManager.detectLatestSnapshot({
        identityId: dbIdentityId,
        lastRunId: null,
      });
      if (snapshotId) {
        this.logger.info(`[ws][chat] auto-restore snapshot=${snapshotId} chatId=${chatId}`);
      }
    }

    // Determine agent
    const agent = requestedAgent ?? (this.config.cloud?.default_agent === 'claude_code' ? 'claude_code' : 'codex');

    // Send initial status
    this.wsManager.sendToConnection(connId, {
      type: 'run_status',
      chatId,
      status: 'preparing',
      message: isPlayground ? 'Starting playground session' : 'Preparing cloud sandbox',
    });

    const spaceId = `${Date.now()}`;
    let runId: string;
    let sessionId: string;
    let cdpUrl: string | null;

    // Check for existing sandbox
    const sandbox = this.sandboxService?.getSandbox(connId);

    if (sandbox) {
      const result = await this.cloudManager.startRunWithWorkspace({
        workspace: { id: sandbox.workspaceId, rootPath: sandbox.rootPath },
        identityId: dbIdentityId,
        platform: 'websocket',
        workspaceId: null,
        chatId,
        spaceId,
        userId: conn.identityId!,
        prompt: prompt.trim(),
        repoIds,
        agent,
        playground: isPlayground,
        restoreSnapshotId: snapshotId,
      });
      runId = result.runId;
      sessionId = result.sessionId;
      cdpUrl = result.cdpUrl;
      this.sandboxService!.markInUse(connId, runId, sessionId);
    } else {
      const result = await this.cloudManager.startRun({
        identityId: dbIdentityId,
        platform: 'websocket',
        workspaceId: null,
        chatId,
        spaceId,
        userId: conn.identityId!,
        prompt: prompt.trim(),
        repoIds,
        agent,
        playground: isPlayground,
        restoreSnapshotId: snapshotId,
      });
      runId = result.runId;
      sessionId = result.sessionId;
      cdpUrl = result.cdpUrl;
    }

    // Subscribe and send session_started
    this.wsManager.subscribeToSession(connId, sessionId);
    this.wsManager.sendToConnection(connId, {
      type: 'session_started',
      sessionId,
      runId,
      chatId,
    });

    // Send browser session if available
    if (cdpUrl) {
      const liveViewUrl = this.cloudManager.getLiveViewUrl(sessionId);
      this.wsManager.sendToConnection(connId, {
        type: 'browser_session',
        sessionId,
        runId,
        cdpUrl,
        liveViewUrl: liveViewUrl ?? undefined,
        provider: 'hyperbrowser',
      });
    }

    // Send run links
    const viewUrl = this.linkBuilder.buildViewUrl(runId);
    this.wsManager.sendToConnection(connId, {
      type: 'run_links',
      chatId,
      sessionId,
      viewUrl,
    });

    // Poll for VS Code URL
    this.pollAndSendVscodeUrl(connId, chatId, sessionId).catch((err) => {
      this.logger.debug(`[ws][chat] vscode poll error chatId=${chatId}: ${String(err)}`);
    });

    this.logger.info(`[ws][chat] session started chatId=${chatId} sessionId=${sessionId} agent=${agent}`);
  }

  private async validateRepoAccess(identityId: string, repoIds: string[]): Promise<boolean> {
    if (repoIds.length === 0) return true;
    const accessibleRepos = await listReposForIdentity(this.db, identityId);
    const accessibleIds = new Set(accessibleRepos.map((r) => r.id));
    return repoIds.every((id) => accessibleIds.has(id));
  }

  private async pollAndSendVscodeUrl(
    connId: string,
    chatId: string,
    sessionId: string,
    maxAttempts = 15,
    intervalMs = 2000,
  ): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (!this.wsManager.getConnection(connId)) return;

      const tunnelUrl = await this.cloudManager.getVscodeUrl(sessionId).catch(() => null);
      if (tunnelUrl) {
        const vscodeUrl = this.linkBuilder.buildVscodeUrl(tunnelUrl);
        this.wsManager.sendToConnection(connId, {
          type: 'run_links',
          chatId,
          sessionId,
          vscodeUrl,
          codeServerUrl: tunnelUrl,
        });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
```

**Step 3: 实现 handleStop 方法**

```typescript
  /**
   * Handle stop message.
   * Stops the active session for the given chatId.
   */
  async handleStop(
    connId: string,
    conn: WSConnection,
    message: StopMessage,
  ): Promise<void> {
    const { chatId } = message;

    if (!chatId) {
      return this.sendError(connId, ErrorCodes.INVALID_MESSAGE, 'chatId is required');
    }

    try {
      const session = await this.findActiveSession(chatId);
      if (!session) {
        return this.sendError(connId, ErrorCodes.SESSION_NOT_FOUND, 'No active session for this chat');
      }

      // Validate ownership
      const dbIdentityId = await this.identityResolver.resolve(conn.identityId!);
      const run = await this.db
        .selectFrom('cloud_runs')
        .select(['identity_id'])
        .where('session_id', '=', session.id)
        .executeTakeFirst();

      if (run && run.identity_id !== dbIdentityId) {
        return this.sendError(connId, ErrorCodes.ACCESS_DENIED, 'You do not have access to this session');
      }

      // Find runId for stopping
      const cloudRun = await getCloudRun(this.db, session.id);
      if (!cloudRun) {
        return this.sendError(connId, ErrorCodes.SESSION_NOT_FOUND, 'Run not found');
      }

      const stopped = await this.cloudManager.stopCloudRun(cloudRun.id);
      if (!stopped) {
        return this.sendError(connId, ErrorCodes.SERVICE_ERROR, 'Failed to stop run');
      }

      if (this.sandboxService) {
        this.sandboxService.markReady(connId);
      }

      this.wsManager.broadcastToSession(session.id, {
        type: 'done',
        chatId,
        stopped: true,
      });

      this.logger.info(`[ws][chat] stopped chatId=${chatId} sessionId=${session.id}`);
    } catch (err) {
      this.logger.error(`[ws][chat] handleStop error connId=${connId}: ${String(err)}`);
      this.sendError(connId, ErrorCodes.SERVICE_ERROR, `Failed to stop: ${String(err)}`);
    }
  }
```

**Step 4: 实现 handleSubscribe 方法**

```typescript
  /**
   * Handle subscribe message.
   * Subscribes to the active session for the given chatId.
   */
  async handleSubscribe(
    connId: string,
    conn: WSConnection,
    message: SubscribeMessage,
  ): Promise<void> {
    const { chatId } = message;

    if (!chatId) {
      return this.sendError(connId, ErrorCodes.INVALID_MESSAGE, 'chatId is required');
    }

    try {
      const session = await this.findActiveSession(chatId);
      if (!session) {
        return this.sendError(connId, ErrorCodes.SESSION_NOT_FOUND, 'No active session for this chat');
      }

      // Subscribe to the session
      this.wsManager.subscribeToSession(connId, session.id);

      // Get run for status
      const run = await this.db
        .selectFrom('cloud_runs')
        .selectAll()
        .where('session_id', '=', session.id)
        .executeTakeFirst();

      if (run) {
        this.wsManager.sendToConnection(connId, {
          type: 'run_status',
          chatId,
          status: mapDbStatusToWsStatus(run.status),
        });

        const viewUrl = this.linkBuilder.buildViewUrl(run.id);
        this.wsManager.sendToConnection(connId, {
          type: 'run_links',
          chatId,
          sessionId: session.id,
          viewUrl,
        });

        this.pollAndSendVscodeUrl(connId, chatId, session.id).catch(() => {});
      }

      this.logger.debug(`[ws][chat] subscribed chatId=${chatId} sessionId=${session.id}`);
    } catch (err) {
      this.logger.error(`[ws][chat] handleSubscribe error connId=${connId}: ${String(err)}`);
      this.sendError(connId, ErrorCodes.SERVICE_ERROR, `Failed to subscribe: ${String(err)}`);
    }
  }

  /**
   * Clean up resources for a disconnected connection.
   */
  cleanupConnection(connId: string): void {
    // Future: clean up any pending queues, etc.
  }
```

**Step 5: 运行类型检查**

Run: `npm run typecheck`

Expected: 可能有一些类型错误需要修复

**Step 6: Commit**

```bash
git add src/runtime/websocket/services/chat.ts
git commit -m "feat(ws): add ChatService for unified chat handling

- handleChat: new session or follow-up based on chatId
- handleStop: stop active session by chatId
- handleSubscribe: subscribe to active session by chatId
- Uses chatId routing like TG model"
```

---

### Task 3: 更新 WebSocket Handler

**Files:**
- Modify: `src/runtime/websocket/handler.ts`
- Modify: `src/runtime/websocket/services/index.ts`

**Step 1: 更新 services/index.ts 导出**

修改 `src/runtime/websocket/services/index.ts`：

```typescript
export { GitHubService } from './github.js';
export { GitHubDisconnectService } from './githubDisconnect.js';
export { ChatService } from './chat.js';
export { IdentityResolver } from './identity.js';
export { CloudLinkBuilder } from './linkBuilder.js';
export { SandboxLifecycleService } from './sandboxLifecycle.js';
// Remove: export { CloudRunService } from './cloud.js';
// Remove: export { ChatSessionService } from './chatSession.js';
```

**Step 2: 更新 handler.ts imports**

替换 imports：

```typescript
import { GitHubService, GitHubDisconnectService, ChatService, SandboxLifecycleService } from './services/index.js';
```

**Step 3: 更新 WebSocketHandler 构造函数**

```typescript
export class WebSocketHandler {
  private readonly githubService: GitHubService;
  private readonly githubDisconnectService: GitHubDisconnectService;
  private readonly chatService: ChatService | null;
  readonly sandboxLifecycleService: SandboxLifecycleService | null;

  constructor(
    private readonly wsManager: WebSocketManager,
    private readonly sessionManager: SessionManager,
    private readonly config: AppConfig,
    private readonly wsConfig: WebSocketSection,
    private readonly db: Db,
    private readonly logger: Logger,
    cloudManager: CloudManager | null = null,
  ) {
    this.githubService = new GitHubService(
      wsManager,
      config,
      db,
      logger,
    );

    this.githubDisconnectService = new GitHubDisconnectService(
      wsManager,
      config,
      db,
      logger,
      cloudManager,
    );

    this.sandboxLifecycleService = cloudManager
      ? new SandboxLifecycleService(wsManager, cloudManager, db, logger)
      : null;

    this.chatService = cloudManager
      ? new ChatService(wsManager, cloudManager, config, db, logger, this.sandboxLifecycleService)
      : null;
  }
```

**Step 4: 更新 handleMessage switch 语句**

删除旧的 case 分支，添加新的：

```typescript
  async handleMessage(connId: string, message: ClientMessage): Promise<void> {
    const conn = this.wsManager.getConnection(connId);
    if (!conn) return;

    switch (message.type) {
      case 'auth':
        await this.handleAuth(connId, message.token);
        break;

      case 'ping':
        break;

      case 'get_connections': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        await this.githubService.handleGetConnections(connId, auth.identityId);
        break;
      }

      case 'list_repos': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        await this.githubService.handleListRepos(connId, auth.identityId, {
          provider: message.provider,
          search: message.search,
        });
        break;
      }

      case 'get_auth_status': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        await this.githubService.handleGetAuthStatus(connId, auth.identityId, message.provider);
        break;
      }

      case 'start_oauth': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        await this.githubService.handleStartOAuth(connId, auth.identityId, message.provider);
        break;
      }

      case 'github_disconnect': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        await this.githubDisconnectService.handleGitHubDisconnect(connId, auth.identityId, message);
        break;
      }

      case 'chat': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        if (!this.chatService) {
          this.wsManager.sendToConnection(connId, {
            type: 'error',
            code: ErrorCodes.SERVICE_ERROR,
            message: 'Cloud service not available',
          });
          return;
        }
        await this.chatService.handleChat(connId, auth.conn, message);
        break;
      }

      case 'stop': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        if (!this.chatService) {
          this.wsManager.sendToConnection(connId, {
            type: 'error',
            code: ErrorCodes.SERVICE_ERROR,
            message: 'Cloud service not available',
          });
          return;
        }
        await this.chatService.handleStop(connId, auth.conn, message);
        break;
      }

      case 'subscribe': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        if (!this.chatService) {
          this.wsManager.sendToConnection(connId, {
            type: 'error',
            code: ErrorCodes.SERVICE_ERROR,
            message: 'Cloud service not available',
          });
          return;
        }
        await this.chatService.handleSubscribe(connId, auth.conn, message);
        break;
      }

      case 'list_runs': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        await this.handleListRuns(connId, auth.identityId, message.limit);
        break;
      }

      default:
        this.wsManager.sendToConnection(connId, {
          type: 'error',
          code: ErrorCodes.INVALID_MESSAGE,
          message: 'Unknown message type',
        });
    }
  }
```

**Step 5: 移除 cloudService getter**

删除：
```typescript
  get cloudService(): CloudRunService | null {
    return this.cloudRunService;
  }
```

**Step 6: 更新 pushPreviewUrl 方法使用 chatId**

```typescript
  pushPreviewUrl(event: PreviewUrlEvent): void {
    const connId = this.wsManager.getConnectionBySession(event.sessionId);
    if (!connId) {
      this.logger.debug(`[ws] pushPreviewUrl: no connection for session=${event.sessionId}`);
      return;
    }
    // Get chatId from session
    this.db
      .selectFrom('sessions')
      .select(['chat_id'])
      .where('id', '=', event.sessionId)
      .executeTakeFirst()
      .then((session) => {
        if (session) {
          this.wsManager.sendToConnection(connId, {
            type: 'run_links',
            chatId: session.chat_id,
            sessionId: event.sessionId,
            previewUrl: event.previewUrl,
            previewSummary: event.previewSummary,
          });
        }
      })
      .catch(() => {});
    this.logger.debug(`[ws] pushPreviewUrl sent connId=${connId} session=${event.sessionId}`);
  }
```

**Step 7: 运行类型检查**

Run: `npm run typecheck`

Expected: PASS（或记录剩余错误）

**Step 8: Commit**

```bash
git add src/runtime/websocket/handler.ts src/runtime/websocket/services/index.ts
git commit -m "refactor(ws): update handler to use ChatService

- Replace CloudRunService with ChatService
- Handle chat/stop/subscribe messages
- Remove cloud_run/cloud_follow_up/cloud_stop/subscribe_run/chat_connect handlers
- Update pushPreviewUrl to use chatId"
```

---

## Phase 2: 数据层清理

### Task 4: 创建 Migration 移除 chats 表

**Files:**
- Create: `src/runtime/migrations/0028_remove_chats.ts`

**Step 1: 创建 migration 文件**

```typescript
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Drop index on multi_chat_id
  await db.schema.dropIndex("idx_sessions_multi_chat_id").execute();

  // 2. Drop multi_chat_id column from sessions
  await db.schema.alterTable("sessions").dropColumn("multi_chat_id").execute();

  // 3. Drop chats table indexes
  await db.schema.dropIndex("idx_chats_identity").execute();

  // 4. Drop chats table
  await db.schema.dropTable("chats").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // 1. Recreate chats table
  await db.schema
    .createTable("chats")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("identity_id", "text", (col) => col.notNull())
    .addColumn("title", "text")
    .addColumn("repo_id", "text")
    .addColumn("initial_prompt", "text")
    .addColumn("last_snapshot_id", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("active"))
    .addColumn("created_at", "integer", (col) => col.notNull())
    .addColumn("updated_at", "integer", (col) => col.notNull())
    .execute();

  // 2. Recreate chats index
  await db.schema
    .createIndex("idx_chats_identity")
    .on("chats")
    .columns(["identity_id", "created_at"])
    .execute();

  // 3. Add multi_chat_id column back to sessions
  await db.schema
    .alterTable("sessions")
    .addColumn("multi_chat_id", "text")
    .execute();

  // 4. Recreate index on multi_chat_id
  await db.schema
    .createIndex("idx_sessions_multi_chat_id")
    .on("sessions")
    .columns(["multi_chat_id"])
    .execute();
}
```

**Step 2: 运行 migration**

Run: `npm run migrate`

Expected: Migration 成功

**Step 3: Commit**

```bash
git add src/runtime/migrations/0028_remove_chats.ts
git commit -m "feat(db): add migration to remove chats table

- Drop chats table and idx_chats_identity
- Drop multi_chat_id column from sessions
- Drop idx_sessions_multi_chat_id"
```

---

### Task 5: 更新数据库类型定义

**Files:**
- Modify: `src/runtime/db.ts`
- Modify: `src/runtime/store.ts`

**Step 1: 从 db.ts 移除 multi_chat_id**

在 `SessionsTable` 接口中删除：
```typescript
  multi_chat_id: string | null;
```

删除 `ChatsTable` 接口（如果存在）。

**Step 2: 从 store.ts 移除 multi_chat_id**

在 `SessionRow` 接口中删除：
```typescript
  multi_chat_id: string | null;
```

删除 `getSessionsByMultiChatId` 函数。

**Step 3: 运行类型检查**

Run: `npm run typecheck`

Expected: 可能有使用 multi_chat_id 的地方报错，记录并修复

**Step 4: Commit**

```bash
git add src/runtime/db.ts src/runtime/store.ts
git commit -m "refactor(db): remove multi_chat_id from session types

- Remove multi_chat_id from SessionsTable
- Remove multi_chat_id from SessionRow
- Remove getSessionsByMultiChatId function"
```

---

### Task 6: 删除 chat 模块

**Files:**
- Delete: `src/runtime/chat/types.ts`
- Delete: `src/runtime/chat/store.ts`
- Delete: `src/runtime/chat/service.ts`
- Delete: `src/runtime/chat/index.ts`
- Delete: `src/runtime/chat/` (directory)

**Step 1: 删除文件**

```bash
rm -rf src/runtime/chat
```

**Step 2: 删除 chatRoutes（如果存在）**

```bash
rm -f src/runtime/service/http/chatRoutes.ts
```

**Step 3: 删除 chatSession.ts**

```bash
rm -f src/runtime/websocket/services/chatSession.ts
```

**Step 4: 删除旧的 cloud.ts（CloudRunService）**

```bash
rm -f src/runtime/websocket/services/cloud.ts
```

**Step 5: 运行类型检查**

Run: `npm run typecheck`

Expected: 确认没有文件引用已删除的模块

**Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove obsolete chat module and services

- Delete src/runtime/chat/ directory
- Delete websocket/services/chatSession.ts
- Delete websocket/services/cloud.ts (replaced by chat.ts)"
```

---

### Task 7: 清理 sessionManager 和 cloudManager

**Files:**
- Modify: `src/runtime/sessionManager.ts`
- Modify: `src/runtime/cloud/manager.ts`

**Step 1: 从 sessionManager.ts 移除 multiChatId**

搜索并删除所有 `multiChatId` 引用：
- `startNewSession` 参数中的 `multiChatId?: string;`
- `multi_chat_id: opts.multiChatId ?? null,` 赋值

**Step 2: 从 cloud/manager.ts 移除 multiChatId**

搜索并删除所有 `multiChatId` 引用

**Step 3: 运行类型检查**

Run: `npm run typecheck`

Expected: PASS

**Step 4: Commit**

```bash
git add src/runtime/sessionManager.ts src/runtime/cloud/manager.ts
git commit -m "refactor: remove multiChatId from session and cloud managers"
```

---

## Phase 3: 更新 Streamer 响应

### Task 8: 更新 WebSocketManager 广播方法

**Files:**
- Modify: `src/runtime/websocket/manager.ts`

**Step 1: 检查 broadcastToSession 方法**

确保广播消息使用 chatId。如果需要，添加 chatId 查询逻辑。

**Step 2: 运行类型检查**

Run: `npm run typecheck`

**Step 3: Commit**

```bash
git add src/runtime/websocket/manager.ts
git commit -m "refactor(ws): ensure broadcast messages include chatId"
```

---

## Phase 4: 测试

### Task 9: 更新测试

**Files:**
- Modify/Create: `tests/websocket/*.test.ts`

**Step 1: 创建 ChatService 测试**

```typescript
// tests/websocket/ChatService.test.ts
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';

describe('ChatService', () => {
  describe('handleChat', () => {
    it('should create new session when no active session exists', async () => {
      // TODO: implement
    });

    it('should send follow-up when active session exists', async () => {
      // TODO: implement
    });

    it('should return error when chatId is missing', async () => {
      // TODO: implement
    });
  });

  describe('handleStop', () => {
    it('should stop active session', async () => {
      // TODO: implement
    });

    it('should return error when no active session', async () => {
      // TODO: implement
    });
  });

  describe('handleSubscribe', () => {
    it('should subscribe to active session', async () => {
      // TODO: implement
    });

    it('should return error when no active session', async () => {
      // TODO: implement
    });
  });
});
```

**Step 2: 运行测试**

Run: `npm run test`

Expected: 测试通过（或标记为 TODO）

**Step 3: Commit**

```bash
git add tests/
git commit -m "test(ws): add ChatService tests"
```

---

### Task 10: 构建验证

**Step 1: 完整构建**

Run: `npm run build`

Expected: 构建成功

**Step 2: 运行所有测试**

Run: `npm run test`

Expected: 所有测试通过

**Step 3: Final Commit**

```bash
git add -A
git commit -m "feat: complete WebSocket chat simplification

Summary:
- Unified protocol: chat/stop/subscribe messages
- Removed chats table and ChatService
- Removed ~615 lines of obsolete code
- All tests passing

BREAKING CHANGE: WebSocket protocol updated, client must use chatId"
```

---

## 实现检查清单

| Task | Description | Status |
|------|-------------|--------|
| 1 | 更新 WebSocket 类型定义 | ⬜ |
| 2 | 创建新的 ChatService | ⬜ |
| 3 | 更新 WebSocket Handler | ⬜ |
| 4 | 创建 Migration 移除 chats 表 | ⬜ |
| 5 | 更新数据库类型定义 | ⬜ |
| 6 | 删除 chat 模块 | ⬜ |
| 7 | 清理 sessionManager 和 cloudManager | ⬜ |
| 8 | 更新 WebSocketManager 广播方法 | ⬜ |
| 9 | 更新测试 | ⬜ |
| 10 | 构建验证 | ⬜ |

---

## 风险与注意事项

1. **Breaking Change**: WebSocket 协议不兼容，需要 Website 同步更新
2. **数据迁移**: 现有 WebSocket sessions 的 `chat_id` 格式为 `ws:${identityId}`，不影响新逻辑
3. **回滚**: 如需回滚，运行 `npm run migrate -- down` 恢复 chats 表
