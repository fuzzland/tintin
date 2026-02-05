import test from "node:test";
import assert from "node:assert/strict";
import { resolveGithubToken } from "../../src/runtime/cloud/githubMcpToken.js";
import { encryptSecret } from "../../src/runtime/cloud/secrets.js";
import type { Db } from "../../src/runtime/db.js";

const SECRET_KEY = "test-secret-key-for-encryption!";

function createMockDb(opts: {
  mcpToken?: string | null;
  installations?: Array<{ installation_id: string; status: string }>;
  installationToken?: { encrypted_token: string; expires_at: number | null } | null;
}): Db {
  return {
    selectFrom: (table: string) => {
      if (table === "github_mcp_tokens") {
        return {
          selectAll: () => ({
            where: () => ({
              executeTakeFirst: async () =>
                opts.mcpToken ? { encrypted_token: opts.mcpToken } : undefined,
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
                  execute: async () => opts.installations ?? [],
                }),
              }),
            }),
          }),
        };
      }
      if (table === "github_installation_tokens") {
        return {
          selectAll: () => ({
            where: () => ({
              executeTakeFirst: async () => opts.installationToken ?? undefined,
            }),
          }),
          select: () => ({
            where: () => ({
              executeTakeFirst: async () =>
                opts.installationToken ? { id: "tok-1" } : undefined,
            }),
          }),
        };
      }
      return {
        selectAll: () => ({
          where: () => ({
            executeTakeFirst: async () => undefined,
          }),
        }),
      };
    },
    updateTable: () => ({
      set: () => ({
        where: () => ({
          execute: async () => {},
        }),
      }),
    }),
    insertInto: () => ({
      values: () => ({
        execute: async () => {},
      }),
    }),
  } as unknown as Db;
}

test("resolveGithubToken returns decrypted token from github_mcp_tokens", async () => {
  const plainToken = "ghp_test_token_12345";
  const encrypted = encryptSecret(plainToken, SECRET_KEY);
  const db = createMockDb({ mcpToken: encrypted });
  const result = await resolveGithubToken({
    db,
    identityId: "identity-1",
    secretKey: SECRET_KEY,
  });
  assert.equal(result, plainToken);
});

test("resolveGithubToken throws when secretKey is empty", async () => {
  const db = createMockDb({});
  await assert.rejects(
    () =>
      resolveGithubToken({
        db,
        identityId: "identity-1",
        secretKey: "",
      }),
    { message: /secrets_key is required/ },
  );
});

test("resolveGithubToken throws when neither source available", async () => {
  const db = createMockDb({
    mcpToken: null,
    installations: [],
  });
  await assert.rejects(
    () =>
      resolveGithubToken({
        db,
        identityId: "identity-1",
        secretKey: SECRET_KEY,
        githubAppConfig: null,
      }),
    { message: /No GitHub token available/ },
  );
});

test("resolveGithubToken throws when no installations and no githubAppConfig", async () => {
  const db = createMockDb({
    mcpToken: null,
    installations: [],
  });
  await assert.rejects(
    () =>
      resolveGithubToken({
        db,
        identityId: "identity-1",
        secretKey: SECRET_KEY,
      }),
    { message: /No GitHub token available/ },
  );
});

test("resolveGithubToken falls back to installation token when MCP table is empty", async () => {
  const installToken = "ghs_installation_token_xyz";
  const encryptedInstall = encryptSecret(installToken, SECRET_KEY);
  const db = createMockDb({
    mcpToken: null,
    installations: [{ installation_id: "42", status: "active" }],
    installationToken: {
      encrypted_token: encryptedInstall,
      expires_at: Date.now() + 3_600_000, // 1 hour in future
    },
  });
  const result = await resolveGithubToken({
    db,
    identityId: "identity-1",
    secretKey: SECRET_KEY,
    githubAppConfig: {
      app_id: "123",
      app_slug: "test-app",
      private_key: "fake-key",
      api_base_url: "https://api.github.com",
      app_base_url: "https://github.com",
      webhook_path: "/webhook",
      webhook_secret: "secret",
    },
  });
  assert.equal(result, installToken);
});

test("resolveGithubToken skips inactive installations", async () => {
  const db = createMockDb({
    mcpToken: null,
    installations: [{ installation_id: "42", status: "suspended" }],
  });
  await assert.rejects(
    () =>
      resolveGithubToken({
        db,
        identityId: "identity-1",
        secretKey: SECRET_KEY,
        githubAppConfig: {
          app_id: "123",
          app_slug: "test-app",
          private_key: "fake-key",
          api_base_url: "https://api.github.com",
          app_base_url: "https://github.com",
          webhook_path: "/webhook",
          webhook_secret: "secret",
        },
      }),
    { message: /No GitHub token available/ },
  );
});
