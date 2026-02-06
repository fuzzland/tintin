# Cross-Platform Cloud Run Sync Design

> 跨平台 Cloud Run 结果同步设计

## Overview

实现在任意平台（Website/TG/Slack）完成的 cloud run，能在其他关联平台同步显示结果。

### Goals

1. 通过 GitHub OAuth 自动关联多平台 identity
2. Cloud run 完成后主动推送摘要卡片到所有关联平台
3. 支持在任意平台查询历史 runs

### Non-Goals

- 实时同步 agent 输出流（仅同步完成结果）
- 支持 GitHub 以外的关联方式（可后续扩展）

---

## Architecture

### System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              User Platforms                                  │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐                │
│  │   Telegram   │     │   Website    │     │    Slack     │                │
│  │   Identity   │     │   Identity   │     │   Identity   │                │
│  └──────┬───────┘     └──────┬───────┘     └──────┬───────┘                │
│         │                    │                    │                         │
│         └────────────────────┼────────────────────┘                         │
│                              │                                              │
│                              ▼                                              │
│                    ┌─────────────────┐                                      │
│                    │ Identity Group  │◄─── GitHub OAuth 自动关联            │
│                    │ (github_user_id)│                                      │
│                    └─────────────────┘                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Notification Layer                                 │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    RunNotificationService                            │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │   │
│  │  │ CardBuilder │  │ GroupQuery  │  │ Dispatcher  │                  │   │
│  │  │ (摘要构建)  │  │ (关联查询)  │  │ (平台分发)  │                  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│         ┌────────────────────┼────────────────────┐                         │
│         ▼                    ▼                    ▼                         │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐                   │
│  │  TG Sender  │     │  WS Sender  │     │Slack Sender │                   │
│  └─────────────┘     └─────────────┘     └─────────────┘                   │
└─────────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Storage Layer                                     │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐             │
│  │ identity_groups │  │   identities    │  │   cloud_runs    │             │
│  │                 │◄─┤   (group_id)    │◄─┤  (identity_id)  │             │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Module Dependency Graph

```
┌──────────────────────────────────────────────────────────────┐
│                     Notification Module                       │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              RunNotificationService                     │ │
│  │                                                         │ │
│  │  Responsibilities:                                      │ │
│  │  - Orchestrate notification flow                        │ │
│  │  - Query related identities                             │ │
│  │  - Delegate to platform senders                         │ │
│  └───────────────────────┬────────────────────────────────┘ │
│                          │                                   │
│           ┌──────────────┼──────────────┐                   │
│           ▼              ▼              ▼                   │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐           │
│  │ CardBuilder │ │ GroupStore  │ │PlatformSender│           │
│  │             │ │             │ │  (Strategy)  │           │
│  │ - buildSum- │ │ - getGroup  │ │              │           │
│  │   maryCard  │ │ - listIden- │ │ - Telegram   │           │
│  │ - format-   │ │   tities    │ │ - Slack      │           │
│  │   DiffStats │ │             │ │ - WebSocket  │           │
│  └─────────────┘ └─────────────┘ └─────────────┘           │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│                    Existing Modules                           │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │CloudManager │  │  Messaging  │  │  WSManager  │          │
│  │(触发通知)   │  │ (TG/Slack)  │  │ (broadcast) │          │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
└──────────────────────────────────────────────────────────────┘
```

---

## Business Flows

### Flow 1: GitHub OAuth 关联

```
┌─────────┐         ┌─────────┐         ┌─────────┐         ┌─────────┐
│  User   │         │Platform │         │  OAuth  │         │  Store  │
│         │         │(TG/Web) │         │ Handler │         │         │
└────┬────┘         └────┬────┘         └────┬────┘         └────┬────┘
     │                   │                   │                   │
     │  1. /connect      │                   │                   │
     │──────────────────>│                   │                   │
     │                   │                   │                   │
     │  2. OAuth URL     │                   │                   │
     │<──────────────────│                   │                   │
     │                   │                   │                   │
     │  3. Authorize on GitHub               │                   │
     │──────────────────────────────────────>│                   │
     │                   │                   │                   │
     │                   │  4. Callback      │                   │
     │                   │  (code)           │                   │
     │                   │<──────────────────│                   │
     │                   │                   │                   │
     │                   │  5. Exchange token│                   │
     │                   │──────────────────>│                   │
     │                   │                   │                   │
     │                   │  6. GET /user     │                   │
     │                   │──────────────────>│ (GitHub API)      │
     │                   │                   │                   │
     │                   │  7. {id, login}   │                   │
     │                   │<──────────────────│                   │
     │                   │                   │                   │
     │                   │  8. Find/Create   │                   │
     │                   │     Group         │                   │
     │                   │──────────────────────────────────────>│
     │                   │                   │                   │
     │                   │  9. Link identity │                   │
     │                   │     to group      │                   │
     │                   │──────────────────────────────────────>│
     │                   │                   │                   │
     │  10. Connected!   │                   │                   │
     │<──────────────────│                   │                   │
     │                   │                   │                   │
```

### Flow 2: Cloud Run 完成推送

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│ Cloud   │    │Notifica-│    │  Card   │    │Platform │    │  User   │
│ Manager │    │tion Svc │    │ Builder │    │ Senders │    │(Target) │
└────┬────┘    └────┬────┘    └────┬────┘    └────┬────┘    └────┬────┘
     │              │              │              │              │
     │ 1. Run       │              │              │              │
     │    Completed │              │              │              │
     │─────────────>│              │              │              │
     │              │              │              │              │
     │              │ 2. Get initiator identity   │              │
     │              │──────────────────────────>  │              │
     │              │                             │              │
     │              │ 3. Query group_id           │              │
     │              │──────────────────────────>  │              │
     │              │                             │              │
     │              │ 4. Find other identities    │              │
     │              │    in same group            │              │
     │              │──────────────────────────>  │              │
     │              │                             │              │
     │              │ 5. Build summary card       │              │
     │              │─────────────>│              │              │
     │              │              │              │              │
     │              │ 6. Card data │              │              │
     │              │<─────────────│              │              │
     │              │              │              │              │
     │              │ 7. Send to each platform    │              │
     │              │────────────────────────────>│              │
     │              │              │              │              │
     │              │              │              │ 8. Message   │
     │              │              │              │─────────────>│
     │              │              │              │              │
```

### Flow 3: 历史查询

```
┌─────────┐         ┌─────────┐         ┌─────────┐
│  User   │         │Controller│        │  Store  │
│ (TG)    │         │         │         │         │
└────┬────┘         └────┬────┘         └────┬────┘
     │                   │                   │
     │  1. /runs         │                   │
     │──────────────────>│                   │
     │                   │                   │
     │                   │ 2. Get identity   │
     │                   │    group_id       │
     │                   │──────────────────>│
     │                   │                   │
     │                   │ 3. List all       │
     │                   │    identities     │
     │                   │    in group       │
     │                   │──────────────────>│
     │                   │                   │
     │                   │ 4. Query runs     │
     │                   │    for identities │
     │                   │──────────────────>│
     │                   │                   │
     │                   │ 5. Runs list      │
     │                   │<──────────────────│
     │                   │                   │
     │  6. Formatted     │                   │
     │     runs list     │                   │
     │<──────────────────│                   │
     │                   │                   │
```

---

## Data Model

### New Table: `identity_groups`

```typescript
export interface IdentityGroupsTable {
  id: string;                    // UUID
  github_user_id: string;        // GitHub 数字 user ID (unique)
  github_login: string | null;   // GitHub 用户名（展示用）
  created_at: number;
  updated_at: number;
}
```

### Modified Table: `identities`

```typescript
export interface IdentitiesTable {
  // ... existing fields ...
  group_id: string | null;       // FK → identity_groups.id (新增)
}
```

### Entity Relationship

```
┌─────────────────────────────────────────────────────────────┐
│                      identity_groups                         │
├─────────────────────────────────────────────────────────────┤
│ PK │ id: string                                              │
│    │ github_user_id: string (UNIQUE)                        │
│    │ github_login: string | null                            │
│    │ created_at: number                                      │
│    │ updated_at: number                                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ 1:N
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        identities                            │
├─────────────────────────────────────────────────────────────┤
│ PK │ id: string                                              │
│ FK │ group_id: string | null ──────────────────────────────>│
│    │ platform: string                                        │
│    │ user_id: string                                         │
│    │ ...                                                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ 1:N
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        cloud_runs                            │
├─────────────────────────────────────────────────────────────┤
│ PK │ id: string                                              │
│ FK │ identity_id: string ───────────────────────────────────>│
│    │ status: string                                          │
│    │ prompt: string                                          │
│    │ ...                                                     │
└─────────────────────────────────────────────────────────────┘
```

---

## Code Design

### Design Principles

遵循以下原则确保代码质量：

| 原则 | 应用 |
|------|------|
| **SRP** (Single Responsibility) | 每个类只负责一件事：CardBuilder 只构建卡片，Dispatcher 只负责分发 |
| **OCP** (Open/Closed) | 通过 Strategy 模式支持新平台，无需修改 NotificationService |
| **DIP** (Dependency Inversion) | 依赖接口而非实现，所有依赖通过构造函数注入 |
| **DRY** (Don't Repeat Yourself) | 卡片格式化逻辑统一在 CardBuilder，各平台只做适配 |

### Module Structure

```
src/runtime/notification/
├── index.ts                    # Public exports
├── types.ts                    # Interfaces and types
├── RunNotificationService.ts   # Orchestrator (主服务)
├── CardBuilder.ts              # Summary card construction
├── GroupStore.ts               # Identity group queries
└── senders/
    ├── index.ts                # Sender registry
    ├── types.ts                # PlatformSender interface
    ├── TelegramSender.ts       # TG-specific formatting
    ├── SlackSender.ts          # Slack blocks formatting
    └── WebSocketSender.ts      # WS broadcast
```

### Interface Definitions

```typescript
// src/runtime/notification/types.ts

/**
 * Summary card data structure.
 * Platform-agnostic representation of a run completion notification.
 */
export interface RunSummaryCard {
  runId: string;
  status: 'completed' | 'error';
  title: string;
  prompt: string;
  diffStats: DiffStats | null;
  screenshotUrl: string | null;
  viewUrl: string;
  vscodeUrl: string | null;
  initiatorPlatform: string;
  finishedAt: number;
}

export interface DiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

/**
 * Target identity for notification delivery.
 */
export interface NotificationTarget {
  identityId: string;
  platform: 'telegram' | 'slack' | 'websocket';
  userId: string;
  workspaceId: string | null;
}
```

### Strategy Pattern for Platform Senders

```typescript
// src/runtime/notification/senders/types.ts

/**
 * Platform-specific sender interface.
 * Implements Strategy pattern for extensibility.
 */
export interface PlatformSender {
  readonly platform: string;

  /**
   * Send notification to a specific target.
   * @returns true if sent successfully, false otherwise
   */
  send(target: NotificationTarget, card: RunSummaryCard): Promise<boolean>;
}
```

```typescript
// src/runtime/notification/senders/TelegramSender.ts

import type { PlatformSender, NotificationTarget, RunSummaryCard } from './types.js';

export class TelegramSender implements PlatformSender {
  readonly platform = 'telegram';

  constructor(
    private readonly bot: TelegramBot,
    private readonly logger: Logger,
  ) {}

  async send(target: NotificationTarget, card: RunSummaryCard): Promise<boolean> {
    const message = this.formatMessage(card);

    try {
      await this.bot.sendMessage(target.userId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      });

      // Send screenshot if available
      if (card.screenshotUrl) {
        await this.bot.sendPhoto(target.userId, card.screenshotUrl);
      }

      return true;
    } catch (err) {
      this.logger.warn(`[tg-sender] failed to send to ${target.userId}: ${err}`);
      return false;
    }
  }

  private formatMessage(card: RunSummaryCard): string {
    const statusEmoji = card.status === 'completed' ? '✅' : '❌';
    const statusText = card.status === 'completed' ? 'Build Completed' : 'Build Failed';

    const lines = [
      `${statusEmoji} *${statusText}*`,
      '',
      `📝 ${this.escapeMarkdown(card.title)}`,
    ];

    if (card.diffStats) {
      const { filesChanged, additions, deletions } = card.diffStats;
      lines.push(`📊 Changes: ${filesChanged} files (+${additions} / -${deletions})`);
    }

    lines.push(`🖥️ From: ${card.initiatorPlatform}`);
    lines.push('');
    lines.push(`[🔗 View Details](${card.viewUrl})`);

    if (card.vscodeUrl) {
      lines.push(`[💻 Open Editor](${card.vscodeUrl})`);
    }

    return lines.join('\n');
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
  }
}
```

### Main Service with Dependency Injection

```typescript
// src/runtime/notification/RunNotificationService.ts

import type { Logger } from '../log.js';
import type { Db } from '../db.js';
import type { PlatformSender, NotificationTarget, RunSummaryCard } from './types.js';
import { CardBuilder } from './CardBuilder.js';
import { GroupStore } from './GroupStore.js';

/**
 * Orchestrates run completion notifications across platforms.
 *
 * Responsibilities:
 * - Query related identities via group
 * - Build summary card
 * - Dispatch to platform senders
 *
 * Does NOT:
 * - Format platform-specific messages (delegated to senders)
 * - Handle retries (each sender handles its own)
 */
export class RunNotificationService {
  private readonly cardBuilder: CardBuilder;
  private readonly groupStore: GroupStore;
  private readonly senders: Map<string, PlatformSender>;

  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
    senders: PlatformSender[],
    private readonly config: NotificationConfig,
  ) {
    this.cardBuilder = new CardBuilder(config);
    this.groupStore = new GroupStore(db);
    this.senders = new Map(senders.map(s => [s.platform, s]));
  }

  /**
   * Notify all related identities about a completed run.
   *
   * @param runId - The completed run ID
   * @param initiatorIdentityId - Identity that started the run
   */
  async notifyRunCompleted(runId: string, initiatorIdentityId: string): Promise<void> {
    // 1. Get initiator's group
    const groupId = await this.groupStore.getGroupIdForIdentity(initiatorIdentityId);
    if (!groupId) {
      this.logger.debug(`[notify] identity ${initiatorIdentityId} has no group, skipping`);
      return;
    }

    // 2. Find other identities in the same group
    const targets = await this.groupStore.listOtherIdentitiesInGroup(
      groupId,
      initiatorIdentityId,
    );

    if (targets.length === 0) {
      this.logger.debug(`[notify] no other identities in group ${groupId}`);
      return;
    }

    // 3. Build summary card
    const card = await this.cardBuilder.buildFromRun(runId);
    if (!card) {
      this.logger.warn(`[notify] failed to build card for run ${runId}`);
      return;
    }

    // 4. Send to each target (parallel, fire-and-forget errors)
    const results = await Promise.allSettled(
      targets.map(target => this.sendToTarget(target, card)),
    );

    // 5. Log summary
    const succeeded = results.filter(r => r.status === 'fulfilled' && r.value).length;
    this.logger.info(
      `[notify] run ${runId} notified ${succeeded}/${targets.length} targets`,
    );
  }

  private async sendToTarget(
    target: NotificationTarget,
    card: RunSummaryCard,
  ): Promise<boolean> {
    const sender = this.senders.get(target.platform);
    if (!sender) {
      this.logger.warn(`[notify] no sender for platform ${target.platform}`);
      return false;
    }

    return sender.send(target, card);
  }
}
```

### Group Store (Data Access Layer)

```typescript
// src/runtime/notification/GroupStore.ts

import type { Db } from '../db.js';
import type { NotificationTarget } from './types.js';

/**
 * Data access for identity groups.
 * Single responsibility: group-related queries.
 */
export class GroupStore {
  constructor(private readonly db: Db) {}

  async getGroupIdForIdentity(identityId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('identities')
      .select('group_id')
      .where('id', '=', identityId)
      .executeTakeFirst();

    return row?.group_id ?? null;
  }

  async listOtherIdentitiesInGroup(
    groupId: string,
    excludeIdentityId: string,
  ): Promise<NotificationTarget[]> {
    const rows = await this.db
      .selectFrom('identities')
      .select(['id', 'platform', 'user_id', 'workspace_id'])
      .where('group_id', '=', groupId)
      .where('id', '!=', excludeIdentityId)
      .execute();

    return rows.map(row => ({
      identityId: row.id,
      platform: row.platform as NotificationTarget['platform'],
      userId: row.user_id,
      workspaceId: row.workspace_id,
    }));
  }

  async getOrCreateGroup(
    githubUserId: string,
    githubLogin: string | null,
  ): Promise<string> {
    const existing = await this.db
      .selectFrom('identity_groups')
      .select('id')
      .where('github_user_id', '=', githubUserId)
      .executeTakeFirst();

    if (existing) {
      return existing.id;
    }

    const now = Date.now();
    const id = crypto.randomUUID();

    await this.db
      .insertInto('identity_groups')
      .values({
        id,
        github_user_id: githubUserId,
        github_login: githubLogin,
        created_at: now,
        updated_at: now,
      })
      .execute();

    return id;
  }

  async linkIdentityToGroup(identityId: string, groupId: string): Promise<void> {
    await this.db
      .updateTable('identities')
      .set({ group_id: groupId, updated_at: Date.now() })
      .where('id', '=', identityId)
      .execute();
  }
}
```

---

## Error Handling

### Resilience Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                    Error Handling Matrix                     │
├──────────────────────┬──────────────────────────────────────┤
│ Error Type           │ Handling Strategy                    │
├──────────────────────┼──────────────────────────────────────┤
│ GitHub API failure   │ Log warn, skip group linking,        │
│ during OAuth         │ OAuth still succeeds                 │
├──────────────────────┼──────────────────────────────────────┤
│ Group creation fails │ Rollback transaction, return error   │
│                      │ to user                              │
├──────────────────────┼──────────────────────────────────────┤
│ Card build fails     │ Log error, abort notification        │
│                      │ (no partial sends)                   │
├──────────────────────┼──────────────────────────────────────┤
│ Single sender fails  │ Log warn, continue other senders     │
│                      │ (partial success OK)                 │
├──────────────────────┼──────────────────────────────────────┤
│ All senders fail     │ Log error, no retry                  │
│                      │ (user can query /runs)               │
└──────────────────────┴──────────────────────────────────────┘
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| User not linked to GitHub | `group_id = null`, no cross-platform sync |
| Only one platform linked | Group exists, but no targets to notify |
| User unlinks GitHub | Keep `group_id`, sync continues |
| Multiple TG accounts | Each identity receives notification |
| Run has no diff | `diffStats = null`, card shows without stats |
| Screenshot upload failed | Card sent without image |

---

## File Changes Summary

### New Files

| File | Lines | Description |
|------|-------|-------------|
| `src/runtime/migrations/XXX_add_identity_groups.ts` | ~30 | DB migration |
| `src/runtime/notification/index.ts` | ~10 | Public exports |
| `src/runtime/notification/types.ts` | ~40 | Type definitions |
| `src/runtime/notification/RunNotificationService.ts` | ~80 | Main orchestrator |
| `src/runtime/notification/CardBuilder.ts` | ~60 | Card construction |
| `src/runtime/notification/GroupStore.ts` | ~70 | Data access |
| `src/runtime/notification/senders/types.ts` | ~15 | Sender interface |
| `src/runtime/notification/senders/TelegramSender.ts` | ~60 | TG sender |
| `src/runtime/notification/senders/SlackSender.ts` | ~80 | Slack sender |
| `src/runtime/notification/senders/WebSocketSender.ts` | ~40 | WS sender |
| `tests/notification/*.test.ts` | ~200 | Unit tests |

### Modified Files

| File | Changes |
|------|---------|
| `src/runtime/db.ts` | Add `IdentityGroupsTable`, add `group_id` to `IdentitiesTable` |
| `src/runtime/cloud/oauth.ts` | Fetch GitHub user ID, call `GroupStore.linkIdentityToGroup` |
| `src/runtime/cloud/githubApp.ts` | Same as above for GitHub App flow |
| `src/runtime/cloud/manager.ts` | Call `RunNotificationService.notifyRunCompleted` on run finish |
| `src/runtime/controller2.ts` | Add `/runs`, `/run <id>` command handlers |
| `src/runtime/websocket/handler.ts` | Add `list_runs` message handler |
| `src/runtime/websocket/types.ts` | Add `list_runs`, `runs_list`, `run_completed_notification` types |
| `src/runtime/service.ts` | Initialize `RunNotificationService` with senders |

### Estimated Total: ~700 lines

---

## Testing Strategy

### Unit Tests

```typescript
// tests/notification/RunNotificationService.test.ts

describe('RunNotificationService', () => {
  describe('notifyRunCompleted', () => {
    it('should skip if identity has no group', async () => {
      // ...
    });

    it('should skip if no other identities in group', async () => {
      // ...
    });

    it('should send to all targets in parallel', async () => {
      // ...
    });

    it('should continue if one sender fails', async () => {
      // ...
    });
  });
});

// tests/notification/GroupStore.test.ts

describe('GroupStore', () => {
  describe('getOrCreateGroup', () => {
    it('should return existing group if found', async () => {
      // ...
    });

    it('should create new group if not found', async () => {
      // ...
    });
  });
});
```

### Integration Tests

```typescript
// tests/notification/integration.test.ts

describe('Cross-platform notification flow', () => {
  it('should notify TG when Website run completes', async () => {
    // 1. Create two identities in same group
    // 2. Start run from website identity
    // 3. Complete run
    // 4. Verify TG sender was called
  });
});
```

---

## Implementation Order

1. **Phase 1: Data Model** (Day 1)
   - [ ] Add migration for `identity_groups` table
   - [ ] Add `group_id` column to `identities`
   - [ ] Update `db.ts` types

2. **Phase 2: Group Linking** (Day 1-2)
   - [ ] Implement `GroupStore`
   - [ ] Modify OAuth callback to fetch GitHub user ID
   - [ ] Link identity to group on OAuth complete

3. **Phase 3: Notification Service** (Day 2-3)
   - [ ] Implement `CardBuilder`
   - [ ] Implement `RunNotificationService`
   - [ ] Implement platform senders (TG, Slack, WS)

4. **Phase 4: Integration** (Day 3)
   - [ ] Call notification service from `CloudManager`
   - [ ] Add `/runs` command to TG/Slack
   - [ ] Add `list_runs` to WebSocket

5. **Phase 5: Testing** (Day 4)
   - [ ] Unit tests for all new modules
   - [ ] Integration test for full flow

---

## Open Questions

1. **Retry policy**: Should we add a retry queue for failed notifications?
   - Current design: No retry, user can query `/runs`
   - Alternative: Add to job queue with exponential backoff

2. **Notification preferences**: Should users be able to opt-out?
   - Current design: Always notify if linked
   - Alternative: Add `notification_enabled` flag to identities

3. **Rate limiting**: What if a user has many runs in quick succession?
   - Current design: No rate limiting
   - Alternative: Debounce or batch notifications

---

*Design created: 2026-02-06*
*Status: Ready for implementation*
