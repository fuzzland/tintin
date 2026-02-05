import test from "node:test";
import assert from "node:assert/strict";
import { GitHubService } from "../../src/runtime/websocket/services/github.js";
import type { ServerMessage } from "../../src/runtime/websocket/types.js";
import type { Db } from "../../src/runtime/db.js";
import type { AppConfig } from "../../src/runtime/config.js";
import type { Logger } from "../../src/runtime/log.js";
import type { WebSocketManager } from "../../src/runtime/websocket/manager.js";

// ============ Mock Factories ============

interface SentMessage {
  connId: string;
  message: ServerMessage;
}

function createMockLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as Logger;
}

function createMockWsManager() {
  const sentMessages: SentMessage[] = [];

  return {
    sendToConnection: (connId: string, message: ServerMessage) => {
      sentMessages.push({ connId, message });
      return true;
    },
    _getSentMessages: () => sentMessages,
    _clearMessages: () => {
      sentMessages.length = 0;
    },
  } as unknown as WebSocketManager & {
    _getSentMessages: () => SentMessage[];
    _clearMessages: () => void;
  };
}

function createMockConfig(opts?: { publicBaseUrl?: string }): AppConfig {
  return {
    cloud: {
      enabled: true,
      secrets_key: "test-secret-key-for-encryption",
      public_base_url: opts?.publicBaseUrl ?? "https://example.com",
      oauth: {
        callback_path: "/oauth/callback",
      },
      github_app: {
        app_id: "12345",
        app_slug: "test-app",
        private_key: "fake-key",
        api_base_url: "https://api.github.com",
        app_base_url: "https://github.com",
        webhook_path: "/webhook",
        webhook_secret: "secret",
      },
      ui: null,
    },
    bot: {
      host: "localhost",
      port: 3000,
    },
  } as unknown as AppConfig;
}

type MockDbRow = Record<string, unknown>;

function createMockDb(opts: {
  identityRow?: MockDbRow | null;
  connections?: MockDbRow[];
  installations?: MockDbRow[];
  githubInstallation?: MockDbRow | null;
}): Db {
  const identityRow = opts.identityRow ?? { id: "db-identity-1" };
  const connections = opts.connections ?? [];
  const installations = opts.installations ?? [];
  const githubInstallation = opts.githubInstallation ?? null;

  return {
    selectFrom: (table: string) => {
      if (table === "identities") {
        return {
          selectAll: () => ({
            where: (_col: string, _op: string, _val: unknown) => ({
              where: () => ({
                where: () => ({
                  executeTakeFirst: async () => identityRow,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "connections") {
        return {
          selectAll: () => ({
            where: (_col: string, _op: string, val: unknown) => ({
              execute: async () => connections,
              where: () => ({
                execute: async () => connections,
              }),
            }),
          }),
        };
      }
      if (table === "github_installation_identities") {
        return {
          innerJoin: () => ({
            select: () => ({
              where: () => ({
                orderBy: () => ({
                  execute: async () => installations,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "github_installations") {
        return {
          selectAll: () => ({
            where: () => ({
              executeTakeFirst: async () => githubInstallation,
            }),
          }),
        };
      }
      return {
        selectAll: () => ({
          where: () => ({
            execute: async () => [],
            executeTakeFirst: async () => undefined,
          }),
        }),
      };
    },
    deleteFrom: () => ({
      where: () => ({
        execute: async () => ({ numDeletedRows: BigInt(0) }),
      }),
    }),
    insertInto: () => ({
      values: () => ({
        execute: async () => {},
      }),
    }),
  } as unknown as Db;
}

// ============ Tests ============

test("handleStartOAuth returns auth_status when already connected via github_app", async () => {
  const wsManager = createMockWsManager();
  const db = createMockDb({
    connections: [
      {
        id: "conn-1",
        type: "github_app",
        installation_id: "42",
        identity_id: "db-identity-1",
        metadata_json: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ],
    githubInstallation: {
      installation_id: "42",
      app_id: "12345",
      account_login: "test-org",
      account_type: "Organization",
      status: "active",
      created_at: Date.now(),
      updated_at: Date.now(),
    },
  });

  const service = new GitHubService(wsManager, createMockConfig(), db, createMockLogger());

  await service.handleStartOAuth("ws-conn-1", "user-1", "github");

  const messages = wsManager._getSentMessages();
  assert.equal(messages.length, 1);
  const msg = messages[0]!.message as unknown as Record<string, unknown>;
  assert.equal(msg.type, "auth_status");
  assert.equal(msg.connected, true);
  assert.equal(msg.accountLogin, "test-org");
});

test("handleStartOAuth cleans stale connections (no installation_id)", async () => {
  let deleteExecuted = false;
  const wsManager = createMockWsManager();

  const baseDb = createMockDb({
    connections: [
      {
        id: "stale-conn",
        type: "github_app",
        installation_id: null,
        identity_id: "db-identity-1",
        metadata_json: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ],
    githubInstallation: null,
  });

  // Override deleteFrom to track deletion
  const db = {
    ...baseDb,
    deleteFrom: (table: string) => ({
      where: (_col: string, _op: string, _val: unknown) => ({
        execute: async () => {
          if (table === "connections") deleteExecuted = true;
          return { numDeletedRows: BigInt(1) };
        },
      }),
    }),
  } as unknown as Db;

  const config = createMockConfig({ publicBaseUrl: "" });
  const service = new GitHubService(wsManager, config, db, createMockLogger());

  // The flow should clean the stale connection, then fail due to empty public_base_url
  try {
    await service.handleStartOAuth("ws-conn-1", "user-1", "github");
  } catch {
    // Expected to fail since we have no valid redirect base
  }

  assert.ok(deleteExecuted, "stale connection should have been cleaned");
});

test("handleStartOAuth requires cloud.public_base_url", async () => {
  const wsManager = createMockWsManager();
  const db = createMockDb({ connections: [] });
  const config = createMockConfig({ publicBaseUrl: "" });

  const service = new GitHubService(wsManager, config, db, createMockLogger());

  await service.handleStartOAuth("ws-conn-1", "user-1", "github");

  const messages = wsManager._getSentMessages();
  assert.equal(messages.length, 1);
  const msg = messages[0]!.message as unknown as Record<string, unknown>;
  assert.equal(msg.type, "error");
  assert.ok(String(msg.message).includes("public_base_url"));
});
