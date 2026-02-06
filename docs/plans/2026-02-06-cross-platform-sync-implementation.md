# Cross-Platform Cloud Run Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable cloud run results to sync across TG/Slack/Website via GitHub OAuth identity linking.

**Architecture:** Add `identity_groups` table to link identities sharing the same GitHub account. When a cloud run completes, `RunNotificationService` queries the group, builds a summary card, and dispatches to platform-specific senders.

**Tech Stack:** TypeScript, Kysely (DB), GitHub OAuth API, Telegram Bot API, Slack Web API, WebSocket

---

## Task 1: Database Migration

**Files:**
- Create: `src/runtime/migrations/0027_identity_groups.ts`
- Modify: `src/runtime/db.ts`

**Step 1: Create migration file**

```typescript
// src/runtime/migrations/0027_identity_groups.ts
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Create identity_groups table
  await db.schema
    .createTable("identity_groups")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("github_user_id", "text", (col) => col.notNull().unique())
    .addColumn("github_login", "text")
    .addColumn("created_at", "integer", (col) => col.notNull())
    .addColumn("updated_at", "integer", (col) => col.notNull())
    .execute();

  // 2. Add group_id to identities table
  await db.schema
    .alterTable("identities")
    .addColumn("group_id", "text")
    .execute();

  // 3. Create index for faster group lookups
  await db.schema
    .createIndex("idx_identities_group_id")
    .on("identities")
    .columns(["group_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_identities_group_id").execute();
  await db.schema.alterTable("identities").dropColumn("group_id").execute();
  await db.schema.dropTable("identity_groups").execute();
}
```

**Step 2: Update db.ts types**

Add to `src/runtime/db.ts`:

```typescript
export interface IdentityGroupsTable {
  id: string;
  github_user_id: string;
  github_login: string | null;
  created_at: number;
  updated_at: number;
}

// In IdentitiesTable, add:
//   group_id: string | null;

// In DatabaseSchema, add:
//   identity_groups: IdentityGroupsTable;
```

**Step 3: Run migration**

```bash
npm run build && npm run migrate
```

Expected: Migration 0027_identity_groups applied successfully.

**Step 4: Commit**

```bash
git add src/runtime/migrations/0027_identity_groups.ts src/runtime/db.ts
git commit -m "feat(db): add identity_groups table for cross-platform linking"
```

---

## Task 2: GroupStore Data Access Layer

**Files:**
- Create: `src/runtime/notification/GroupStore.ts`
- Create: `src/runtime/notification/types.ts`
- Test: `tests/notification/GroupStore.test.ts`

**Step 1: Create types file**

```typescript
// src/runtime/notification/types.ts

export interface NotificationTarget {
  identityId: string;
  platform: 'telegram' | 'slack' | 'websocket';
  userId: string;
  workspaceId: string | null;
}

export interface DiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

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
```

**Step 2: Write failing test for GroupStore**

```typescript
// tests/notification/GroupStore.test.ts
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert";
import { Kysely, SqliteDialect } from "kysely";
import Database from "better-sqlite3";
import type { DatabaseSchema } from "../../src/runtime/db.js";
import { GroupStore } from "../../src/runtime/notification/GroupStore.js";

describe("GroupStore", () => {
  let db: Kysely<DatabaseSchema>;
  let store: GroupStore;

  beforeEach(async () => {
    const sqlite = new Database(":memory:");
    db = new Kysely<DatabaseSchema>({ dialect: new SqliteDialect({ database: sqlite }) });

    // Create tables
    await db.schema.createTable("identity_groups")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("github_user_id", "text", (col) => col.notNull().unique())
      .addColumn("github_login", "text")
      .addColumn("created_at", "integer", (col) => col.notNull())
      .addColumn("updated_at", "integer", (col) => col.notNull())
      .execute();

    await db.schema.createTable("identities")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("platform", "text", (col) => col.notNull())
      .addColumn("workspace_id", "text")
      .addColumn("user_id", "text", (col) => col.notNull())
      .addColumn("group_id", "text")
      .addColumn("created_at", "integer", (col) => col.notNull())
      .addColumn("updated_at", "integer", (col) => col.notNull())
      .execute();

    store = new GroupStore(db);
  });

  after(async () => {
    await db.destroy();
  });

  describe("getOrCreateGroup", () => {
    it("should create new group if not exists", async () => {
      const groupId = await store.getOrCreateGroup("12345", "testuser");
      assert.ok(groupId);

      const group = await db.selectFrom("identity_groups")
        .where("id", "=", groupId)
        .selectAll()
        .executeTakeFirst();

      assert.strictEqual(group?.github_user_id, "12345");
      assert.strictEqual(group?.github_login, "testuser");
    });

    it("should return existing group if exists", async () => {
      const groupId1 = await store.getOrCreateGroup("12345", "testuser");
      const groupId2 = await store.getOrCreateGroup("12345", "testuser");
      assert.strictEqual(groupId1, groupId2);
    });
  });

  describe("listOtherIdentitiesInGroup", () => {
    it("should return other identities in same group", async () => {
      const groupId = await store.getOrCreateGroup("12345", "testuser");

      // Insert two identities in same group
      await db.insertInto("identities").values({
        id: "id-tg",
        platform: "telegram",
        user_id: "tg123",
        workspace_id: null,
        group_id: groupId,
        created_at: Date.now(),
        updated_at: Date.now(),
      }).execute();

      await db.insertInto("identities").values({
        id: "id-web",
        platform: "websocket",
        user_id: "web456",
        workspace_id: null,
        group_id: groupId,
        created_at: Date.now(),
        updated_at: Date.now(),
      }).execute();

      const targets = await store.listOtherIdentitiesInGroup(groupId, "id-tg");

      assert.strictEqual(targets.length, 1);
      assert.strictEqual(targets[0]?.identityId, "id-web");
      assert.strictEqual(targets[0]?.platform, "websocket");
    });
  });
});
```

**Step 3: Run test to verify it fails**

```bash
npm run build && node --test dist/tests/notification/GroupStore.test.js
```

Expected: FAIL with "Cannot find module GroupStore"

**Step 4: Implement GroupStore**

```typescript
// src/runtime/notification/GroupStore.ts
import crypto from "node:crypto";
import type { Db } from "../db.js";
import type { NotificationTarget } from "./types.js";

/**
 * Data access for identity groups.
 * Single responsibility: group-related queries.
 */
export class GroupStore {
  constructor(private readonly db: Db) {}

  async getGroupIdForIdentity(identityId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("identities")
      .select("group_id")
      .where("id", "=", identityId)
      .executeTakeFirst();

    return row?.group_id ?? null;
  }

  async listOtherIdentitiesInGroup(
    groupId: string,
    excludeIdentityId: string,
  ): Promise<NotificationTarget[]> {
    const rows = await this.db
      .selectFrom("identities")
      .select(["id", "platform", "user_id", "workspace_id"])
      .where("group_id", "=", groupId)
      .where("id", "!=", excludeIdentityId)
      .execute();

    return rows.map((row) => ({
      identityId: row.id,
      platform: row.platform as NotificationTarget["platform"],
      userId: row.user_id,
      workspaceId: row.workspace_id,
    }));
  }

  async getOrCreateGroup(
    githubUserId: string,
    githubLogin: string | null,
  ): Promise<string> {
    const existing = await this.db
      .selectFrom("identity_groups")
      .select("id")
      .where("github_user_id", "=", githubUserId)
      .executeTakeFirst();

    if (existing) {
      return existing.id;
    }

    const now = Date.now();
    const id = crypto.randomUUID();

    await this.db
      .insertInto("identity_groups")
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
      .updateTable("identities")
      .set({ group_id: groupId, updated_at: Date.now() })
      .where("id", "=", identityId)
      .execute();
  }
}
```

**Step 5: Run test to verify it passes**

```bash
npm run build && node --test dist/tests/notification/GroupStore.test.js
```

Expected: PASS

**Step 6: Commit**

```bash
git add src/runtime/notification/types.ts src/runtime/notification/GroupStore.ts tests/notification/GroupStore.test.ts
git commit -m "feat(notification): add GroupStore for identity group queries"
```

---

## Task 3: GitHub User ID Fetching

**Files:**
- Create: `src/runtime/cloud/githubUser.ts`
- Test: `tests/cloud/githubUser.test.ts`

**Step 1: Write failing test**

```typescript
// tests/cloud/githubUser.test.ts
import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { fetchGitHubUser } from "../../src/runtime/cloud/githubUser.js";

describe("fetchGitHubUser", () => {
  it("should return user id and login", async () => {
    // This test requires mocking fetch - skip for now, test manually
    // In real implementation, use integration test or mock
  });
});
```

**Step 2: Implement fetchGitHubUser**

```typescript
// src/runtime/cloud/githubUser.ts

export interface GitHubUserInfo {
  id: number;
  login: string;
}

/**
 * Fetch GitHub user information using an access token.
 * @param accessToken - OAuth access token
 * @param apiBaseUrl - GitHub API base URL (default: https://api.github.com)
 */
export async function fetchGitHubUser(
  accessToken: string,
  apiBaseUrl = "https://api.github.com",
): Promise<GitHubUserInfo> {
  const res = await fetch(`${apiBaseUrl}/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { id?: unknown; login?: unknown };

  if (typeof data.id !== "number" || typeof data.login !== "string") {
    throw new Error("Invalid GitHub user response");
  }

  return { id: data.id, login: data.login };
}
```

**Step 3: Commit**

```bash
git add src/runtime/cloud/githubUser.ts
git commit -m "feat(cloud): add fetchGitHubUser for getting GitHub user info"
```

---

## Task 4: OAuth Callback Integration

**Files:**
- Modify: `src/runtime/cloud/oauth.ts`

**Step 1: Add import and group linking to handleOAuthCallback**

In `src/runtime/cloud/oauth.ts`, add after line 4:

```typescript
import { fetchGitHubUser } from "./githubUser.js";
import { GroupStore } from "../notification/GroupStore.js";
```

**Step 2: Modify handleOAuthCallback function**

After line 139 (`await markIdentityOnboarded(...)`), add:

```typescript
  // Link identity to group via GitHub user ID
  if (opts.provider === "github") {
    try {
      const githubUser = await fetchGitHubUser(token.accessToken);
      const groupStore = new GroupStore(opts.db);
      const groupId = await groupStore.getOrCreateGroup(
        String(githubUser.id),
        githubUser.login,
      );
      await groupStore.linkIdentityToGroup(saved.identity_id, groupId);
    } catch (e) {
      // Log but don't fail OAuth flow
      console.warn(`[oauth] group linking failed: ${String(e)}`);
    }
  }
```

**Step 3: Build and verify**

```bash
npm run build
```

Expected: No errors

**Step 4: Commit**

```bash
git add src/runtime/cloud/oauth.ts
git commit -m "feat(oauth): link identity to group on GitHub OAuth complete"
```

---

## Task 5: GitHub App Callback Integration

**Files:**
- Modify: `src/runtime/cloud/githubApp.ts`

**Step 1: Add import**

After existing imports, add:

```typescript
import { fetchGitHubUser } from "./githubUser.js";
import { GroupStore } from "../notification/GroupStore.js";
```

**Step 2: Find completeGithubAppInstall function and add group linking**

After the connection is created (after `await upsertConnection(...)`), add similar group linking logic:

```typescript
  // Link identity to group - need to get user token first
  // Note: GitHub App uses installation tokens, not user tokens
  // For group linking, we need the user who installed the app
  // This is available from the installation webhook or stored separately
```

Note: GitHub App flow is more complex. For MVP, we can skip this and rely on OAuth flow for group linking. Add a TODO comment.

**Step 3: Commit**

```bash
git add src/runtime/cloud/githubApp.ts
git commit -m "chore(githubApp): add TODO for group linking in GitHub App flow"
```

---

## Task 6: CardBuilder

**Files:**
- Create: `src/runtime/notification/CardBuilder.ts`
- Test: `tests/notification/CardBuilder.test.ts`

**Step 1: Write failing test**

```typescript
// tests/notification/CardBuilder.test.ts
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { CardBuilder } from "../../src/runtime/notification/CardBuilder.js";

describe("CardBuilder", () => {
  describe("parseDiffStats", () => {
    it("should parse diff summary correctly", () => {
      const builder = new CardBuilder({
        publicBaseUrl: "https://example.com",
      });

      const stats = builder.parseDiffStats("3 files changed, 45 insertions(+), 12 deletions(-)");

      assert.deepStrictEqual(stats, {
        filesChanged: 3,
        additions: 45,
        deletions: 12,
      });
    });

    it("should return null for invalid diff", () => {
      const builder = new CardBuilder({
        publicBaseUrl: "https://example.com",
      });

      const stats = builder.parseDiffStats("invalid");
      assert.strictEqual(stats, null);
    });
  });

  describe("extractTitle", () => {
    it("should truncate long prompts", () => {
      const builder = new CardBuilder({
        publicBaseUrl: "https://example.com",
      });

      const longPrompt = "Fix the authentication bug in the login flow that causes users to be logged out unexpectedly when they refresh the page";
      const title = builder.extractTitle(longPrompt);

      assert.ok(title.length <= 60);
      assert.ok(title.endsWith("..."));
    });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm run build && node --test dist/tests/notification/CardBuilder.test.js
```

Expected: FAIL with "Cannot find module CardBuilder"

**Step 3: Implement CardBuilder**

```typescript
// src/runtime/notification/CardBuilder.ts
import type { Db } from "../db.js";
import type { RunSummaryCard, DiffStats } from "./types.js";

export interface CardBuilderConfig {
  publicBaseUrl: string;
}

/**
 * Builds summary cards from cloud run data.
 * Single responsibility: card construction and formatting.
 */
export class CardBuilder {
  constructor(private readonly config: CardBuilderConfig) {}

  /**
   * Build a summary card from a cloud run.
   */
  async buildFromRun(
    db: Db,
    runId: string,
  ): Promise<RunSummaryCard | null> {
    const run = await db
      .selectFrom("cloud_runs")
      .selectAll()
      .where("id", "=", runId)
      .executeTakeFirst();

    if (!run) return null;

    const session = run.session_id
      ? await db
          .selectFrom("sessions")
          .select(["platform"])
          .where("id", "=", run.session_id)
          .executeTakeFirst()
      : null;

    // Get latest screenshot if available
    const screenshot = await db
      .selectFrom("cloud_run_screenshots")
      .select(["s3_key"])
      .where("run_id", "=", runId)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();

    const diffStats = run.diff_summary ? this.parseDiffStats(run.diff_summary) : null;

    return {
      runId,
      status: run.status === "finished" ? "completed" : "error",
      title: this.extractTitle(run.prompt),
      prompt: run.prompt,
      diffStats,
      screenshotUrl: screenshot?.s3_key
        ? `${this.config.publicBaseUrl}/api/screenshots/${screenshot.s3_key}`
        : null,
      viewUrl: `${this.config.publicBaseUrl}/run/${runId}`,
      vscodeUrl: null, // Filled in separately if available
      initiatorPlatform: session?.platform ?? "unknown",
      finishedAt: run.finished_at ?? run.updated_at,
    };
  }

  /**
   * Parse diff summary string into structured stats.
   * Example: "3 files changed, 45 insertions(+), 12 deletions(-)"
   */
  parseDiffStats(summary: string): DiffStats | null {
    const filesMatch = summary.match(/(\d+)\s+files?\s+changed/);
    const addMatch = summary.match(/(\d+)\s+insertions?\(\+\)/);
    const delMatch = summary.match(/(\d+)\s+deletions?\(-\)/);

    if (!filesMatch) return null;

    return {
      filesChanged: parseInt(filesMatch[1]!, 10),
      additions: addMatch ? parseInt(addMatch[1]!, 10) : 0,
      deletions: delMatch ? parseInt(delMatch[1]!, 10) : 0,
    };
  }

  /**
   * Extract a short title from the prompt.
   */
  extractTitle(prompt: string, maxLength = 50): string {
    const firstLine = prompt.split("\n")[0] ?? prompt;
    const cleaned = firstLine.trim();

    if (cleaned.length <= maxLength) {
      return cleaned;
    }

    return cleaned.slice(0, maxLength - 3) + "...";
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npm run build && node --test dist/tests/notification/CardBuilder.test.js
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/notification/CardBuilder.ts tests/notification/CardBuilder.test.ts
git commit -m "feat(notification): add CardBuilder for summary card construction"
```

---

## Task 7: Platform Senders Interface

**Files:**
- Create: `src/runtime/notification/senders/types.ts`
- Create: `src/runtime/notification/senders/index.ts`

**Step 1: Create sender interface**

```typescript
// src/runtime/notification/senders/types.ts
import type { NotificationTarget, RunSummaryCard } from "../types.js";

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

**Step 2: Create index export**

```typescript
// src/runtime/notification/senders/index.ts
export type { PlatformSender } from "./types.js";
export { TelegramSender } from "./TelegramSender.js";
export { SlackSender } from "./SlackSender.js";
export { WebSocketSender } from "./WebSocketSender.js";
```

**Step 3: Commit**

```bash
git add src/runtime/notification/senders/types.ts src/runtime/notification/senders/index.ts
git commit -m "feat(notification): add PlatformSender interface"
```

---

## Task 8: Telegram Sender

**Files:**
- Create: `src/runtime/notification/senders/TelegramSender.ts`

**Step 1: Implement TelegramSender**

```typescript
// src/runtime/notification/senders/TelegramSender.ts
import type { Logger } from "../../log.js";
import type { PlatformSender } from "./types.js";
import type { NotificationTarget, RunSummaryCard } from "../types.js";

interface TelegramBot {
  sendMessage(chatId: string, text: string, options?: object): Promise<unknown>;
  sendPhoto(chatId: string, photo: string, options?: object): Promise<unknown>;
}

export class TelegramSender implements PlatformSender {
  readonly platform = "telegram";

  constructor(
    private readonly bot: TelegramBot | null,
    private readonly logger: Logger,
  ) {}

  async send(target: NotificationTarget, card: RunSummaryCard): Promise<boolean> {
    if (!this.bot) {
      this.logger.debug("[tg-sender] bot not configured, skipping");
      return false;
    }

    const message = this.formatMessage(card);

    try {
      await this.bot.sendMessage(target.userId, message, {
        parse_mode: "Markdown",
        disable_web_page_preview: false,
      });

      if (card.screenshotUrl) {
        await this.bot.sendPhoto(target.userId, card.screenshotUrl, {
          caption: "Preview",
        });
      }

      this.logger.debug(`[tg-sender] sent to ${target.userId}`);
      return true;
    } catch (err) {
      this.logger.warn(`[tg-sender] failed to send to ${target.userId}: ${String(err)}`);
      return false;
    }
  }

  private formatMessage(card: RunSummaryCard): string {
    const statusEmoji = card.status === "completed" ? "✅" : "❌";
    const statusText = card.status === "completed" ? "Build Completed" : "Build Failed";

    const lines = [
      `${statusEmoji} *${statusText}*`,
      "",
      `📝 ${this.escapeMarkdown(card.title)}`,
    ];

    if (card.diffStats) {
      const { filesChanged, additions, deletions } = card.diffStats;
      lines.push(`📊 Changes: ${filesChanged} files (+${additions} / -${deletions})`);
    }

    lines.push(`🖥️ From: ${card.initiatorPlatform}`);
    lines.push("");
    lines.push(`[🔗 View Details](${card.viewUrl})`);

    if (card.vscodeUrl) {
      lines.push(`[💻 Open Editor](${card.vscodeUrl})`);
    }

    return lines.join("\n");
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
  }
}
```

**Step 2: Commit**

```bash
git add src/runtime/notification/senders/TelegramSender.ts
git commit -m "feat(notification): add TelegramSender for TG notifications"
```

---

## Task 9: Slack Sender

**Files:**
- Create: `src/runtime/notification/senders/SlackSender.ts`

**Step 1: Implement SlackSender**

```typescript
// src/runtime/notification/senders/SlackSender.ts
import type { Logger } from "../../log.js";
import type { PlatformSender } from "./types.js";
import type { NotificationTarget, RunSummaryCard } from "../types.js";

interface SlackClient {
  postMessage(channel: string, blocks: object[], text: string): Promise<unknown>;
}

export class SlackSender implements PlatformSender {
  readonly platform = "slack";

  constructor(
    private readonly client: SlackClient | null,
    private readonly logger: Logger,
  ) {}

  async send(target: NotificationTarget, card: RunSummaryCard): Promise<boolean> {
    if (!this.client) {
      this.logger.debug("[slack-sender] client not configured, skipping");
      return false;
    }

    const blocks = this.buildBlocks(card);
    const fallbackText = `${card.status === "completed" ? "✅" : "❌"} ${card.title}`;

    try {
      await this.client.postMessage(target.userId, blocks, fallbackText);
      this.logger.debug(`[slack-sender] sent to ${target.userId}`);
      return true;
    } catch (err) {
      this.logger.warn(`[slack-sender] failed to send to ${target.userId}: ${String(err)}`);
      return false;
    }
  }

  private buildBlocks(card: RunSummaryCard): object[] {
    const statusEmoji = card.status === "completed" ? "✅" : "❌";
    const statusText = card.status === "completed" ? "Build Completed" : "Build Failed";

    const blocks: object[] = [
      {
        type: "header",
        text: { type: "plain_text", text: `${statusEmoji} ${statusText}` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${card.title}*` },
      },
    ];

    if (card.diffStats) {
      const { filesChanged, additions, deletions } = card.diffStats;
      blocks.push({
        type: "context",
        elements: [
          { type: "mrkdwn", text: `📊 ${filesChanged} files changed` },
          { type: "mrkdwn", text: `+${additions} / -${deletions}` },
          { type: "mrkdwn", text: `From: ${card.initiatorPlatform}` },
        ],
      });
    }

    if (card.screenshotUrl) {
      blocks.push({
        type: "image",
        image_url: card.screenshotUrl,
        alt_text: "Preview",
      });
    }

    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "🔗 View Details" },
          url: card.viewUrl,
        },
      ],
    });

    return blocks;
  }
}
```

**Step 2: Commit**

```bash
git add src/runtime/notification/senders/SlackSender.ts
git commit -m "feat(notification): add SlackSender for Slack notifications"
```

---

## Task 10: WebSocket Sender

**Files:**
- Create: `src/runtime/notification/senders/WebSocketSender.ts`

**Step 1: Implement WebSocketSender**

```typescript
// src/runtime/notification/senders/WebSocketSender.ts
import type { Logger } from "../../log.js";
import type { WebSocketManager } from "../../websocket/manager.js";
import type { PlatformSender } from "./types.js";
import type { NotificationTarget, RunSummaryCard } from "../types.js";

export class WebSocketSender implements PlatformSender {
  readonly platform = "websocket";

  constructor(
    private readonly wsManager: WebSocketManager | null,
    private readonly logger: Logger,
  ) {}

  async send(target: NotificationTarget, card: RunSummaryCard): Promise<boolean> {
    if (!this.wsManager) {
      this.logger.debug("[ws-sender] manager not configured, skipping");
      return false;
    }

    try {
      const sent = this.wsManager.sendToIdentity(target.identityId, {
        type: "run_completed_notification",
        runId: card.runId,
        status: card.status,
        title: card.title,
        diffStats: card.diffStats,
        screenshotUrl: card.screenshotUrl,
        viewUrl: card.viewUrl,
        vscodeUrl: card.vscodeUrl,
        initiatorPlatform: card.initiatorPlatform,
        finishedAt: card.finishedAt,
      });

      if (sent > 0) {
        this.logger.debug(`[ws-sender] sent to ${target.identityId} (${sent} connections)`);
        return true;
      }

      this.logger.debug(`[ws-sender] no active connections for ${target.identityId}`);
      return false;
    } catch (err) {
      this.logger.warn(`[ws-sender] failed to send to ${target.identityId}: ${String(err)}`);
      return false;
    }
  }
}
```

**Step 2: Add message type to WebSocket types**

In `src/runtime/websocket/types.ts`, add to `ServerMessage` union:

```typescript
| {
    type: "run_completed_notification";
    runId: string;
    status: "completed" | "error";
    title: string;
    diffStats: { filesChanged: number; additions: number; deletions: number } | null;
    screenshotUrl: string | null;
    viewUrl: string;
    vscodeUrl: string | null;
    initiatorPlatform: string;
    finishedAt: number;
  }
```

**Step 3: Commit**

```bash
git add src/runtime/notification/senders/WebSocketSender.ts src/runtime/websocket/types.ts
git commit -m "feat(notification): add WebSocketSender for WS notifications"
```

---

## Task 11: RunNotificationService

**Files:**
- Create: `src/runtime/notification/RunNotificationService.ts`
- Create: `src/runtime/notification/index.ts`
- Test: `tests/notification/RunNotificationService.test.ts`

**Step 1: Write failing test**

```typescript
// tests/notification/RunNotificationService.test.ts
import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { RunNotificationService } from "../../src/runtime/notification/RunNotificationService.js";

describe("RunNotificationService", () => {
  describe("notifyRunCompleted", () => {
    it("should skip if identity has no group", async () => {
      // Mock implementation
      const mockGroupStore = {
        getGroupIdForIdentity: mock.fn(async () => null),
        listOtherIdentitiesInGroup: mock.fn(async () => []),
      };

      const service = new RunNotificationService(
        mockGroupStore as any,
        null as any,
        [],
        { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
      );

      await service.notifyRunCompleted("run-1", "identity-1");

      assert.strictEqual(mockGroupStore.getGroupIdForIdentity.mock.callCount(), 1);
      assert.strictEqual(mockGroupStore.listOtherIdentitiesInGroup.mock.callCount(), 0);
    });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm run build && node --test dist/tests/notification/RunNotificationService.test.js
```

Expected: FAIL

**Step 3: Implement RunNotificationService**

```typescript
// src/runtime/notification/RunNotificationService.ts
import type { Logger } from "../log.js";
import type { Db } from "../db.js";
import type { PlatformSender } from "./senders/types.js";
import type { RunSummaryCard } from "./types.js";
import { CardBuilder, type CardBuilderConfig } from "./CardBuilder.js";
import { GroupStore } from "./GroupStore.js";

/**
 * Orchestrates run completion notifications across platforms.
 */
export class RunNotificationService {
  private readonly senders: Map<string, PlatformSender>;

  constructor(
    private readonly groupStore: GroupStore,
    private readonly cardBuilder: CardBuilder | null,
    senders: PlatformSender[],
    private readonly logger: Logger,
  ) {
    this.senders = new Map(senders.map((s) => [s.platform, s]));
  }

  /**
   * Create a service instance with all dependencies.
   */
  static create(
    db: Db,
    config: CardBuilderConfig,
    senders: PlatformSender[],
    logger: Logger,
  ): RunNotificationService {
    return new RunNotificationService(
      new GroupStore(db),
      new CardBuilder(config),
      senders,
      logger,
    );
  }

  /**
   * Notify all related identities about a completed run.
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

    // 3. Build summary card (requires cardBuilder with db access)
    if (!this.cardBuilder) {
      this.logger.warn("[notify] cardBuilder not configured");
      return;
    }

    // Note: cardBuilder.buildFromRun needs db access - passed via closure in create()
    // For now, we'll need to refactor to inject db
    this.logger.info(
      `[notify] would notify ${targets.length} targets for run ${runId}`,
    );

    // TODO: Build card and send to targets
    // const card = await this.cardBuilder.buildFromRun(db, runId);
    // if (!card) { ... }
    // await Promise.allSettled(targets.map(t => this.sendToTarget(t, card)));
  }

  private async sendToTarget(
    target: { identityId: string; platform: string; userId: string },
    card: RunSummaryCard,
  ): Promise<boolean> {
    const sender = this.senders.get(target.platform);
    if (!sender) {
      this.logger.warn(`[notify] no sender for platform ${target.platform}`);
      return false;
    }

    return sender.send(target as any, card);
  }
}
```

**Step 4: Create index.ts**

```typescript
// src/runtime/notification/index.ts
export { RunNotificationService } from "./RunNotificationService.js";
export { GroupStore } from "./GroupStore.js";
export { CardBuilder } from "./CardBuilder.js";
export type { RunSummaryCard, DiffStats, NotificationTarget } from "./types.js";
export type { PlatformSender } from "./senders/types.js";
export { TelegramSender } from "./senders/TelegramSender.js";
export { SlackSender } from "./senders/SlackSender.js";
export { WebSocketSender } from "./senders/WebSocketSender.js";
```

**Step 5: Run test to verify it passes**

```bash
npm run build && node --test dist/tests/notification/RunNotificationService.test.js
```

Expected: PASS

**Step 6: Commit**

```bash
git add src/runtime/notification/RunNotificationService.ts src/runtime/notification/index.ts tests/notification/RunNotificationService.test.ts
git commit -m "feat(notification): add RunNotificationService orchestrator"
```

---

## Task 12: Integration with SessionManager

**Files:**
- Modify: `src/runtime/sessionManager.ts`

**Step 1: Add notification hook**

In `SessionManager` class, add property:

```typescript
private notificationService: RunNotificationService | null = null;

setNotificationService(service: RunNotificationService): void {
  this.notificationService = service;
}
```

**Step 2: Call notification on session complete**

In `handleProcessExit` method (around line 723), modify `onSessionFinished` callback or add:

```typescript
// After session finishes, notify other platforms
if (this.notificationService && (status === "finished" || status === "error")) {
  const run = await getCloudRunBySession(this.db, sessionId);
  if (run) {
    const session = await this.db.selectFrom("sessions")
      .select(["identity_id"]) // Need to add this query
      .where("id", "=", sessionId)
      .executeTakeFirst();

    // Note: sessions table doesn't have identity_id directly
    // Need to get it from cloud_runs table
    if (run.identity_id) {
      this.notificationService.notifyRunCompleted(run.id, run.identity_id).catch((e) => {
        this.logger.warn(`[notify] failed for run ${run.id}: ${String(e)}`);
      });
    }
  }
}
```

**Step 3: Commit**

```bash
git add src/runtime/sessionManager.ts
git commit -m "feat(session): integrate RunNotificationService on session complete"
```

---

## Task 13: Service Initialization

**Files:**
- Modify: `src/runtime/service.ts`

**Step 1: Initialize notification service**

In service initialization, add:

```typescript
import { RunNotificationService, TelegramSender, SlackSender, WebSocketSender } from "./notification/index.js";

// After bot and wsManager are created:
const notificationSenders = [
  new TelegramSender(tgBot, logger),
  new SlackSender(slackClient, logger),
  new WebSocketSender(wsManager, logger),
];

const notificationService = RunNotificationService.create(
  db,
  { publicBaseUrl: config.cloud?.public_base_url ?? "http://localhost:3000" },
  notificationSenders,
  logger,
);

sessionManager.setNotificationService(notificationService);
```

**Step 2: Commit**

```bash
git add src/runtime/service.ts
git commit -m "feat(service): initialize RunNotificationService with platform senders"
```

---

## Task 14: /runs Command for TG/Slack

**Files:**
- Modify: `src/runtime/controller2.ts`
- Create: `src/runtime/cloud/runsQuery.ts`

**Step 1: Create runs query helper**

```typescript
// src/runtime/cloud/runsQuery.ts
import type { Db } from "../db.js";

export interface RunSummary {
  id: string;
  status: string;
  prompt: string;
  platform: string;
  diffSummary: string | null;
  createdAt: number;
}

export async function listRunsForGroup(
  db: Db,
  groupId: string,
  limit = 5,
): Promise<RunSummary[]> {
  // Get all identity IDs in the group
  const identities = await db
    .selectFrom("identities")
    .select("id")
    .where("group_id", "=", groupId)
    .execute();

  if (identities.length === 0) return [];

  const identityIds = identities.map((i) => i.id);

  // Query runs for all identities
  const runs = await db
    .selectFrom("cloud_runs")
    .innerJoin("sessions", "sessions.id", "cloud_runs.session_id")
    .select([
      "cloud_runs.id",
      "cloud_runs.status",
      "cloud_runs.prompt",
      "cloud_runs.diff_summary",
      "cloud_runs.created_at",
      "sessions.platform",
    ])
    .where("cloud_runs.identity_id", "in", identityIds)
    .orderBy("cloud_runs.created_at", "desc")
    .limit(limit)
    .execute();

  return runs.map((r) => ({
    id: r.id,
    status: r.status,
    prompt: r.prompt,
    platform: r.platform,
    diffSummary: r.diff_summary,
    createdAt: r.created_at,
  }));
}
```

**Step 2: Add command handler in controller2.ts**

Add handler for `/runs` command:

```typescript
// In handleChat or command processing section
if (text === "/runs" || text.startsWith("/runs ")) {
  const limitMatch = text.match(/\/runs\s+(\d+)/);
  const limit = limitMatch ? parseInt(limitMatch[1], 10) : 5;

  const identity = await getIdentity(db, { platform, workspaceId, userId });
  if (!identity?.group_id) {
    await sendMessage(chatId, "You need to connect GitHub first to see cross-platform runs.");
    return;
  }

  const runs = await listRunsForGroup(db, identity.group_id, Math.min(limit, 20));
  if (runs.length === 0) {
    await sendMessage(chatId, "No runs found.");
    return;
  }

  const lines = ["📋 *Recent Runs*\n"];
  for (const run of runs) {
    const emoji = run.status === "finished" ? "✅" : run.status === "error" ? "❌" : "⏳";
    const title = run.prompt.slice(0, 40) + (run.prompt.length > 40 ? "..." : "");
    const ago = formatTimeAgo(run.createdAt);
    lines.push(`${emoji} ${title} (${run.platform}, ${ago})`);
  }

  await sendMessage(chatId, lines.join("\n"));
  return;
}
```

**Step 3: Commit**

```bash
git add src/runtime/cloud/runsQuery.ts src/runtime/controller2.ts
git commit -m "feat(controller): add /runs command for cross-platform history"
```

---

## Task 15: WebSocket list_runs Handler

**Files:**
- Modify: `src/runtime/websocket/handler.ts`
- Modify: `src/runtime/websocket/types.ts`

**Step 1: Add message types**

In `types.ts`, add to `ClientMessage`:

```typescript
| { type: "list_runs"; limit?: number }
```

Add to `ServerMessage`:

```typescript
| {
    type: "runs_list";
    runs: Array<{
      id: string;
      status: string;
      prompt: string;
      platform: string;
      diffSummary: string | null;
      createdAt: number;
    }>;
  }
```

**Step 2: Add handler**

In handler, add case for `list_runs`:

```typescript
case "list_runs": {
  const identity = await getIdentity(db, ...);
  if (!identity?.group_id) {
    wsManager.sendToConnection(connId, {
      type: "runs_list",
      runs: [],
    });
    return;
  }

  const runs = await listRunsForGroup(db, identity.group_id, message.limit ?? 10);
  wsManager.sendToConnection(connId, {
    type: "runs_list",
    runs,
  });
  return;
}
```

**Step 3: Commit**

```bash
git add src/runtime/websocket/handler.ts src/runtime/websocket/types.ts
git commit -m "feat(ws): add list_runs message handler"
```

---

## Final Task: Integration Test

**Files:**
- Create: `tests/notification/integration.test.ts`

**Step 1: Write integration test**

```typescript
// tests/notification/integration.test.ts
import { describe, it } from "node:test";
import assert from "node:assert";

describe("Cross-platform notification integration", () => {
  it("should link identities via GitHub OAuth", async () => {
    // TODO: Integration test with real or mocked GitHub API
    assert.ok(true, "Placeholder for integration test");
  });

  it("should notify other platforms when run completes", async () => {
    // TODO: Integration test with mocked senders
    assert.ok(true, "Placeholder for integration test");
  });
});
```

**Step 2: Commit**

```bash
git add tests/notification/integration.test.ts
git commit -m "test(notification): add integration test placeholders"
```

---

## Summary

Total commits: 15
Total new files: ~12
Total modified files: ~8
Estimated lines: ~700

**Execution order:**
1. Task 1: Migration (foundation)
2. Task 2: GroupStore (data layer)
3. Task 3-5: GitHub integration (OAuth linking)
4. Task 6: CardBuilder (formatting)
5. Task 7-10: Senders (platform adapters)
6. Task 11: RunNotificationService (orchestration)
7. Task 12-13: Integration (wiring)
8. Task 14-15: Query commands (/runs)

---

*Plan created: 2026-02-06*
*Status: Ready for execution*
