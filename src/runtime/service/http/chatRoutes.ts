import type http from "node:http";
import type { Db } from "../../db.js";
import type { Logger } from "../../log.js";
import type { AppConfig } from "../../config.js";
import { ChatService } from "../../chat/index.js";
import { verifyProxyToken } from "../../cloud/proxy.js";
import { readHeader, readRequestBody, sendJson, sendText } from "../httpUtils.js";

export type ChatApiDeps = {
  config: AppConfig;
  db: Db;
  logger: Logger;
};

function extractIdentityFromToken(deps: ChatApiDeps, req: http.IncomingMessage): string | null {
  const authHeader = readHeader(req, "authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice(7);
  const secret = deps.config.cloud?.proxy?.shared_secret;

  if (!secret) {
    return null;
  }

  const verified = verifyProxyToken(secret, token);
  return verified?.identityId ?? null;
}

export async function handleCreateChat(
  deps: ChatApiDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const identityId = extractIdentityFromToken(deps, req);
  if (!identityId) {
    sendText(res, 401, "Unauthorized");
    return;
  }

  let body: string;
  try {
    body = await readRequestBody(req, 64 * 1024); // 64KB limit
  } catch {
    sendText(res, 400, "Body too large");
    return;
  }

  let data: { prompt: string; repoId?: string };
  try {
    data = JSON.parse(body);
  } catch {
    sendText(res, 400, "Invalid JSON");
    return;
  }

  if (!data.prompt || typeof data.prompt !== "string") {
    sendText(res, 400, "prompt is required");
    return;
  }

  const chatService = new ChatService(deps.db, deps.logger);

  try {
    const chat = await chatService.createChat({
      identityId,
      prompt: data.prompt,
      repoId: data.repoId,
    });

    sendJson(res, 201, {
      chatId: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
    });
  } catch (err) {
    deps.logger.error(`[chat-api] create failed: ${String(err)}`);
    sendText(res, 500, "Internal server error");
  }
}

export async function handleListChats(
  deps: ChatApiDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  const identityId = extractIdentityFromToken(deps, req);
  if (!identityId) {
    sendText(res, 401, "Unauthorized");
    return;
  }

  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const cursor = url.searchParams.get("cursor") ?? undefined;

  const chatService = new ChatService(deps.db, deps.logger);

  try {
    const chats = await chatService.listChats(identityId, { limit, cursor });

    const nextCursor = chats.length === limit && chats.length > 0
      ? String(chats[chats.length - 1]!.createdAt)
      : null;

    sendJson(res, 200, {
      chats: chats.map((c) => ({
        id: c.id,
        title: c.title,
        repoId: c.repoId,
        status: c.status,
        lastSnapshotId: c.lastSnapshotId,
        updatedAt: c.updatedAt,
      })),
      nextCursor,
    });
  } catch (err) {
    deps.logger.error(`[chat-api] list failed: ${String(err)}`);
    sendText(res, 500, "Internal server error");
  }
}

export async function handleGetChat(
  deps: ChatApiDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  chatId: string,
): Promise<void> {
  const identityId = extractIdentityFromToken(deps, req);
  if (!identityId) {
    sendText(res, 401, "Unauthorized");
    return;
  }

  const chatService = new ChatService(deps.db, deps.logger);

  try {
    const chat = await chatService.getChat(chatId, identityId);

    if (!chat) {
      sendText(res, 404, "Chat not found");
      return;
    }

    sendJson(res, 200, {
      id: chat.id,
      title: chat.title,
      repoId: chat.repoId,
      initialPrompt: chat.initialPrompt,
      lastSnapshotId: chat.lastSnapshotId,
      status: chat.status,
      sessions: chat.sessions,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    });
  } catch (err) {
    deps.logger.error(`[chat-api] get failed: ${String(err)}`);
    sendText(res, 500, "Internal server error");
  }
}

export async function handleDeleteChat(
  deps: ChatApiDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  chatId: string,
): Promise<void> {
  const identityId = extractIdentityFromToken(deps, req);
  if (!identityId) {
    sendText(res, 401, "Unauthorized");
    return;
  }

  const chatService = new ChatService(deps.db, deps.logger);

  try {
    const deleted = await chatService.deleteChat(chatId, identityId);

    if (!deleted) {
      sendText(res, 404, "Chat not found");
      return;
    }

    sendJson(res, 200, { success: true });
  } catch (err) {
    deps.logger.error(`[chat-api] delete failed: ${String(err)}`);
    sendText(res, 500, "Internal server error");
  }
}
