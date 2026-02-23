import test from "node:test";
import assert from "node:assert/strict";
import { ToolCallManager } from "../../src/runtime/streamer/ToolCallManager.js";
import type { PendingToolCall } from "../../src/runtime/streamer/types.js";

const call = (text: string, toolName: string, toolInput?: string): PendingToolCall => ({
  text,
  toolName,
  ...(toolInput !== undefined ? { toolInput } : {}),
});

test("ToolCallManager push/shift", async (t) => {
  await t.test("should push and shift a tool call", () => {
    const manager = new ToolCallManager();
    manager.push("session-1", call("$ ls -la", "Bash", "ls -la"));
    const shifted = manager.shift("session-1");
    assert.ok(shifted);
    assert.equal(shifted.text, "$ ls -la");
    assert.equal(shifted.toolName, "Bash");
    assert.equal(shifted.toolInput, "ls -la");
  });

  await t.test("should shift tool call in FIFO order", () => {
    const manager = new ToolCallManager();
    manager.push("session-1", call("$ ls -la", "Bash", "ls -la"));
    manager.push("session-1", call("$ cat file.txt", "Bash", "cat file.txt"));

    const first = manager.shift("session-1");
    assert.ok(first);
    assert.equal(first.text, "$ ls -la");
    assert.equal(first.toolName, "Bash");
    assert.equal(first.toolInput, "ls -la");

    const second = manager.shift("session-1");
    assert.ok(second);
    assert.equal(second.text, "$ cat file.txt");

    assert.equal(manager.shift("session-1"), null);
  });

  await t.test("should return null when queue is empty", () => {
    const manager = new ToolCallManager();
    assert.equal(manager.shift("session-1"), null);
  });

  await t.test("should handle multiple sessions independently", () => {
    const manager = new ToolCallManager();
    manager.push("session-1", call("call-1", "Bash"));
    manager.push("session-2", call("call-2", "Read"));

    const s1 = manager.shift("session-1");
    const s2 = manager.shift("session-2");
    assert.ok(s1);
    assert.equal(s1.text, "call-1");
    assert.equal(s1.toolName, "Bash");
    assert.ok(s2);
    assert.equal(s2.text, "call-2");
    assert.equal(s2.toolName, "Read");
    assert.equal(manager.shift("session-1"), null);
    assert.equal(manager.shift("session-2"), null);
  });
});

test("ToolCallManager clear", async (t) => {
  await t.test("should clear specific session queue", () => {
    const manager = new ToolCallManager();
    manager.push("session-1", call("call-1", "Bash"));
    manager.push("session-1", call("call-2", "Read"));
    manager.clear("session-1");

    assert.equal(manager.shift("session-1"), null);
  });

  await t.test("should not affect other sessions", () => {
    const manager = new ToolCallManager();
    manager.push("session-1", call("call-1", "Bash"));
    manager.push("session-2", call("call-2", "Read"));
    manager.clear("session-1");

    assert.equal(manager.shift("session-1"), null);
    const s2 = manager.shift("session-2");
    assert.ok(s2);
    assert.equal(s2.text, "call-2");
  });
});

test("ToolCallManager clearExcept", async (t) => {
  await t.test("should clear all sessions except specified", () => {
    const manager = new ToolCallManager();
    manager.push("session-1", call("call-1", "Bash"));
    manager.push("session-2", call("call-2", "Read"));
    manager.push("session-3", call("call-3", "Write"));

    manager.clearExcept(new Set(["session-2"]));

    assert.equal(manager.shift("session-1"), null);
    assert.ok(manager.shift("session-2"));
    assert.equal(manager.shift("session-3"), null);
  });

  await t.test("should handle empty keep set", () => {
    const manager = new ToolCallManager();
    manager.push("session-1", call("call-1", "Bash"));
    manager.push("session-2", call("call-2", "Read"));

    manager.clearExcept(new Set());

    assert.equal(manager.shift("session-1"), null);
    assert.equal(manager.shift("session-2"), null);
  });
});
