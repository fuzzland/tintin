import test from "node:test";
import assert from "node:assert/strict";
import { ToolCallManager } from "../../src/runtime/streamer/ToolCallManager.js";

test("ToolCallManager push/shift", async (t) => {
  await t.test("should push tool call to queue", () => {
    const manager = new ToolCallManager();
    manager.push("session-1", "$ ls -la");
    assert.equal(manager.hasPending("session-1"), true);
    assert.equal(manager.pendingCount("session-1"), 1);
  });

  await t.test("should shift tool call in FIFO order", () => {
    const manager = new ToolCallManager();
    manager.push("session-1", "$ ls -la");
    manager.push("session-1", "$ cat file.txt");

    assert.equal(manager.shift("session-1"), "$ ls -la");
    assert.equal(manager.shift("session-1"), "$ cat file.txt");
    assert.equal(manager.shift("session-1"), null);
  });

  await t.test("should return null when queue is empty", () => {
    const manager = new ToolCallManager();
    assert.equal(manager.shift("session-1"), null);
  });

  await t.test("should handle multiple sessions independently", () => {
    const manager = new ToolCallManager();
    manager.push("session-1", "call-1");
    manager.push("session-2", "call-2");

    assert.equal(manager.shift("session-1"), "call-1");
    assert.equal(manager.shift("session-2"), "call-2");
    assert.equal(manager.hasPending("session-1"), false);
    assert.equal(manager.hasPending("session-2"), false);
  });
});

test("ToolCallManager hasPending", async (t) => {
  await t.test("should return true when queue has items", () => {
    const manager = new ToolCallManager();
    manager.push("session-1", "call-1");
    assert.equal(manager.hasPending("session-1"), true);
  });

  await t.test("should return false for empty queue", () => {
    const manager = new ToolCallManager();
    manager.push("session-1", "call-1");
    manager.shift("session-1");
    assert.equal(manager.hasPending("session-1"), false);
  });

  await t.test("should return false for unknown session", () => {
    const manager = new ToolCallManager();
    assert.equal(manager.hasPending("unknown-session"), false);
  });
});

test("ToolCallManager clear", async (t) => {
  await t.test("should clear specific session queue", () => {
    const manager = new ToolCallManager();
    manager.push("session-1", "call-1");
    manager.push("session-1", "call-2");
    manager.clear("session-1");

    assert.equal(manager.hasPending("session-1"), false);
    assert.equal(manager.pendingCount("session-1"), 0);
  });

  await t.test("should not affect other sessions", () => {
    const manager = new ToolCallManager();
    manager.push("session-1", "call-1");
    manager.push("session-2", "call-2");
    manager.clear("session-1");

    assert.equal(manager.hasPending("session-1"), false);
    assert.equal(manager.hasPending("session-2"), true);
  });
});

test("ToolCallManager clearExcept", async (t) => {
  await t.test("should clear all sessions except specified", () => {
    const manager = new ToolCallManager();
    manager.push("session-1", "call-1");
    manager.push("session-2", "call-2");
    manager.push("session-3", "call-3");

    manager.clearExcept(new Set(["session-2"]));

    assert.equal(manager.hasPending("session-1"), false);
    assert.equal(manager.hasPending("session-2"), true);
    assert.equal(manager.hasPending("session-3"), false);
  });

  await t.test("should handle empty keep set", () => {
    const manager = new ToolCallManager();
    manager.push("session-1", "call-1");
    manager.push("session-2", "call-2");

    manager.clearExcept(new Set());

    assert.equal(manager.hasPending("session-1"), false);
    assert.equal(manager.hasPending("session-2"), false);
  });
});

test("ToolCallManager getSessionIds", async (t) => {
  await t.test("should return all session IDs with pending calls", () => {
    const manager = new ToolCallManager();
    manager.push("session-1", "call-1");
    manager.push("session-2", "call-2");

    const ids = manager.getSessionIds();
    assert.equal(ids.length, 2);
    assert.ok(ids.includes("session-1"));
    assert.ok(ids.includes("session-2"));
  });

  await t.test("should return empty array when no sessions", () => {
    const manager = new ToolCallManager();
    assert.deepEqual(manager.getSessionIds(), []);
  });
});
