import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createTestDb, closeTestDb } from "../helpers/db.js";
import {
  insertChat,
  selectChatById,
  selectChatsByIdentity,
  updateChatSnapshot,
  deleteChatById,
} from "../../src/runtime/chat/store.js";
import type { Db } from "../../src/runtime/db.js";

let db: Db;

test.before(async () => {
  db = await createTestDb();
});

test.after(async () => {
  await closeTestDb(db);
});

test("insertChat creates a new chat", async () => {
  const chatId = crypto.randomUUID();
  const identityId = crypto.randomUUID();

  const chat = await insertChat(db, {
    id: chatId,
    identityId,
    title: "Test Chat",
    repoId: null,
    initialPrompt: "Hello world",
    status: "active",
  });

  assert.equal(chat.id, chatId);
  assert.equal(chat.identityId, identityId);
  assert.equal(chat.title, "Test Chat");
  assert.equal(chat.initialPrompt, "Hello world");
});

test("selectChatById returns chat when exists", async () => {
  const chatId = crypto.randomUUID();
  const identityId = crypto.randomUUID();

  await insertChat(db, {
    id: chatId,
    identityId,
    title: "Find Me",
    repoId: null,
    initialPrompt: "Test prompt",
    status: "active",
  });

  const found = await selectChatById(db, chatId);
  assert.ok(found);
  assert.equal(found.id, chatId);
  assert.equal(found.title, "Find Me");
});

test("selectChatById returns null when not exists", async () => {
  const found = await selectChatById(db, "nonexistent-id");
  assert.equal(found, null);
});

test("selectChatsByIdentity returns chats in descending order", async () => {
  const identityId = crypto.randomUUID();

  await insertChat(db, {
    id: crypto.randomUUID(),
    identityId,
    title: "First",
    repoId: null,
    initialPrompt: "p1",
    status: "active",
  });

  // Small delay to ensure different timestamps
  await new Promise((r) => setTimeout(r, 10));

  await insertChat(db, {
    id: crypto.randomUUID(),
    identityId,
    title: "Second",
    repoId: null,
    initialPrompt: "p2",
    status: "active",
  });

  const chats = await selectChatsByIdentity(db, identityId, { limit: 10 });
  assert.equal(chats.length, 2);
  assert.equal(chats[0]!.title, "Second"); // Most recent first
  assert.equal(chats[1]!.title, "First");
});

test("updateChatSnapshot updates last_snapshot_id", async () => {
  const chatId = crypto.randomUUID();
  const identityId = crypto.randomUUID();

  await insertChat(db, {
    id: chatId,
    identityId,
    title: "Snapshot Test",
    repoId: null,
    initialPrompt: "test",
    status: "active",
  });

  await updateChatSnapshot(db, chatId, "snap-123");

  const updated = await selectChatById(db, chatId);
  assert.ok(updated);
  assert.equal(updated.lastSnapshotId, "snap-123");
});

test("deleteChatById removes the chat", async () => {
  const chatId = crypto.randomUUID();
  const identityId = crypto.randomUUID();

  await insertChat(db, {
    id: chatId,
    identityId,
    title: "Delete Me",
    repoId: null,
    initialPrompt: "test",
    status: "active",
  });

  await deleteChatById(db, chatId);

  const found = await selectChatById(db, chatId);
  assert.equal(found, null);
});
