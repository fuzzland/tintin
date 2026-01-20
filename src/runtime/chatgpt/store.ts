import crypto from "node:crypto";
import type { Db } from "../db.js";
import { nowMs } from "../util.js";

export interface ChatgptAccountUpsert {
  identityId: string;
  chatgptUserId: string;
  email: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string | null;
  workspaceId: string | null;
}

export async function replaceChatgptOAuthState(db: Db, opts: {
  identityId: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  metadataJson?: string | null;
  ttlMs: number;
}): Promise<void> {
  const now = nowMs();
  await db.deleteFrom("chatgpt_oauth_states").where("identity_id", "=", opts.identityId).execute();
  await db
    .insertInto("chatgpt_oauth_states")
    .values({
      id: crypto.randomUUID(),
      identity_id: opts.identityId,
      state: opts.state,
      code_verifier: opts.codeVerifier,
      redirect_uri: opts.redirectUri,
      metadata_json: opts.metadataJson ?? null,
      expires_at: now + opts.ttlMs,
      created_at: now,
    })
    .execute();
}

export async function getChatgptOAuthStateForIdentity(db: Db, identityId: string) {
  const now = nowMs();
  return await db
    .selectFrom("chatgpt_oauth_states")
    .selectAll()
    .where("identity_id", "=", identityId)
    .where("expires_at", ">", now)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
}

export async function consumeChatgptOAuthState(db: Db, state: string) {
  const row = await db.selectFrom("chatgpt_oauth_states").selectAll().where("state", "=", state).executeTakeFirst();
  if (!row) return null;
  await db.deleteFrom("chatgpt_oauth_states").where("id", "=", row.id).execute();
  if (row.expires_at <= nowMs()) return null;
  return row;
}

export async function purgeExpiredChatgptStates(db: Db): Promise<number> {
  const now = nowMs();
  const res = await db.deleteFrom("chatgpt_oauth_states").where("expires_at", "<=", now).executeTakeFirst();
  const count = typeof res.numDeletedRows === "bigint" ? Number(res.numDeletedRows) : Number(res.numDeletedRows ?? 0);
  return Number.isFinite(count) ? count : 0;
}

export async function getChatgptAccount(db: Db, identityId: string) {
  return await db.selectFrom("chatgpt_accounts").selectAll().where("identity_id", "=", identityId).executeTakeFirst();
}

export async function upsertChatgptAccount(db: Db, opts: ChatgptAccountUpsert) {
  const now = nowMs();
  const existing = await getChatgptAccount(db, opts.identityId);
  if (existing) {
    await db
      .updateTable("chatgpt_accounts")
      .set({
        chatgpt_user_id: opts.chatgptUserId,
        email: opts.email,
        access_token: opts.accessToken,
        refresh_token: opts.refreshToken,
        expires_at: opts.expiresAt,
        scope: opts.scope,
        workspace_id: opts.workspaceId,
        updated_at: now,
      })
      .where("id", "=", existing.id)
      .execute();
    return { ...existing, ...opts, updated_at: now };
  }
  const id = crypto.randomUUID();
  await db
    .insertInto("chatgpt_accounts")
    .values({
      id,
      identity_id: opts.identityId,
      chatgpt_user_id: opts.chatgptUserId,
      email: opts.email,
      access_token: opts.accessToken,
      refresh_token: opts.refreshToken,
      expires_at: opts.expiresAt,
      scope: opts.scope,
      workspace_id: opts.workspaceId,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return await db.selectFrom("chatgpt_accounts").selectAll().where("id", "=", id).executeTakeFirst();
}

export async function deleteChatgptAccount(db: Db, identityId: string): Promise<void> {
  await db.deleteFrom("chatgpt_accounts").where("identity_id", "=", identityId).execute();
}
