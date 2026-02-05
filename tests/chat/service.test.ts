import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createTestDb, closeTestDb } from "../helpers/db.js";
import { ChatService } from "../../src/runtime/chat/service.js";
import type { Db } from "../../src/runtime/db.js";

let db: Db;
let service: ChatService;

function createMockLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

test.before(async () => {
  db = await createTestDb();
  service = new ChatService(db, createMockLogger() as any);
});

test.after(async () => {
  await closeTestDb(db);
});

test("createChat creates a chat with auto-generated title", async () => {
  const identityId = crypto.randomUUID();

  const chat = await service.createChat({
    identityId,
    prompt: "Help me create a React project with TypeScript",
  });

  assert.ok(chat.id);
  assert.equal(chat.identityId, identityId);
  assert.ok(chat.title); // Should be auto-generated
  assert.equal(chat.initialPrompt, "Help me create a React project with TypeScript");
  assert.equal(chat.status, "active");
});

test("createChat with repoId", async () => {
  const identityId = crypto.randomUUID();
  const repoId = "github:123456";

  const chat = await service.createChat({
    identityId,
    prompt: "Fix the bug",
    repoId,
  });

  assert.equal(chat.repoId, repoId);
});

test("listChats returns chats for identity", async () => {
  const identityId = crypto.randomUUID();

  await service.createChat({ identityId, prompt: "Chat 1" });
  await service.createChat({ identityId, prompt: "Chat 2" });

  const chats = await service.listChats(identityId);
  assert.equal(chats.length, 2);
});

test("getChat returns chat with sessions", async () => {
  const identityId = crypto.randomUUID();

  const created = await service.createChat({
    identityId,
    prompt: "Test chat",
  });

  const detail = await service.getChat(created.id, identityId);
  assert.ok(detail);
  assert.equal(detail.id, created.id);
  assert.ok(Array.isArray(detail.sessions));
});

test("getChat returns null for wrong identity", async () => {
  const identityId1 = crypto.randomUUID();
  const identityId2 = crypto.randomUUID();

  const created = await service.createChat({
    identityId: identityId1,
    prompt: "Private chat",
  });

  const detail = await service.getChat(created.id, identityId2);
  assert.equal(detail, null);
});

test("deleteChat removes the chat", async () => {
  const identityId = crypto.randomUUID();

  const created = await service.createChat({
    identityId,
    prompt: "Delete me",
  });

  await service.deleteChat(created.id, identityId);

  const found = await service.getChat(created.id, identityId);
  assert.equal(found, null);
});

test("generateTitle extracts meaningful title from prompt", () => {
  const svc = new ChatService(db, createMockLogger() as any);

  assert.equal(
    svc.generateTitle("Help me create a React project"),
    "Help me create a React project"
  );

  assert.equal(
    svc.generateTitle("This is a very long prompt that should be truncated because it exceeds the maximum allowed length for a title"),
    "This is a very long prompt that should be truncated because..."
  );

  assert.equal(
    svc.generateTitle("Fix bug"),
    "Fix bug"
  );
});
