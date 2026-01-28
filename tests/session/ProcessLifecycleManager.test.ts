import test from "node:test";
import assert from "node:assert/strict";
import { ProcessLifecycleManager } from "../../src/runtime/session/ProcessLifecycleManager.js";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

// Mock logger
const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Mock child process
function createMockChild(killed = false): ChildProcessWithoutNullStreams {
  const emitter = new EventEmitter();
  return {
    pid: Math.floor(Math.random() * 10000),
    killed,
    kill: function(signal?: NodeJS.Signals) {
      (this as any).killed = true;
      return true;
    },
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
  } as unknown as ChildProcessWithoutNullStreams;
}

// Mock debug object with all required fields
const mockDebug = {
  kind: "exec",
  binary: "/usr/bin/test",
  cwd: "/tmp",
  args: [],
  envOverrides: [],
  stderrTail: () => "",
  stdoutTail: () => "",
};

test("ProcessLifecycleManager register", async (t) => {
  await t.test("should register process with timeout", () => {
    const manager = new ProcessLifecycleManager(mockLogger as any);
    const child = createMockChild();
    const timeout = setTimeout(() => {}, 60000);

    manager.register("session-1", child, {
      timeout,
      kind: "exec",
      agent: "codex",
      debug: mockDebug,
    });

    assert.equal(manager.has("session-1"), true);
    assert.equal(manager.size, 1);

    clearTimeout(timeout);
  });

  await t.test("should reject duplicate registration", () => {
    const manager = new ProcessLifecycleManager(mockLogger as any);
    const child = createMockChild();
    const timeout = setTimeout(() => {}, 60000);

    manager.register("session-1", child, {
      timeout,
      kind: "exec",
      agent: "codex",
      debug: mockDebug,
    });

    assert.throws(() => {
      manager.register("session-1", createMockChild(), {
        timeout: setTimeout(() => {}, 60000),
        kind: "exec",
        agent: "codex",
        debug: mockDebug,
      });
    }, /already has a registered process/);

    clearTimeout(timeout);
  });
});

test("ProcessLifecycleManager unregister", async (t) => {
  await t.test("should clear timeout on unregister", () => {
    const manager = new ProcessLifecycleManager(mockLogger as any);
    const child = createMockChild();
    let timeoutCleared = false;
    const timeout = setTimeout(() => {
      timeoutCleared = false;
    }, 60000);

    manager.register("session-1", child, {
      timeout,
      kind: "exec",
      agent: "codex",
      debug: mockDebug,
    });

    const proc = manager.unregister("session-1");

    assert.ok(proc);
    assert.equal(manager.has("session-1"), false);
  });

  await t.test("should return process context", () => {
    const manager = new ProcessLifecycleManager(mockLogger as any);
    const child = createMockChild();
    const timeout = setTimeout(() => {}, 60000);

    manager.register("session-1", child, {
      timeout,
      kind: "exec",
      agent: "codex",
      debug: mockDebug,
    });

    const proc = manager.unregister("session-1");

    assert.ok(proc);
    assert.equal(proc.kind, "exec");
    assert.equal(proc.agent, "codex");

    clearTimeout(timeout);
  });

  await t.test("should return undefined for unknown session", () => {
    const manager = new ProcessLifecycleManager(mockLogger as any);
    const proc = manager.unregister("unknown");
    assert.equal(proc, undefined);
  });
});

test("ProcessLifecycleManager kill", async (t) => {
  await t.test("should send SIGTERM by default", () => {
    const manager = new ProcessLifecycleManager(mockLogger as any);
    const child = createMockChild();
    const timeout = setTimeout(() => {}, 60000);

    manager.register("session-1", child, {
      timeout,
      kind: "exec",
      agent: "codex",
      debug: mockDebug,
    });

    const result = manager.kill("session-1");

    assert.equal(result, true);
    assert.equal(child.killed, true);

    clearTimeout(timeout);
  });

  await t.test("should return false for unknown session", () => {
    const manager = new ProcessLifecycleManager(mockLogger as any);
    const result = manager.kill("unknown");
    assert.equal(result, false);
  });
});

test("ProcessLifecycleManager isAlive", async (t) => {
  await t.test("should return true for live process", () => {
    const manager = new ProcessLifecycleManager(mockLogger as any);
    const child = createMockChild(false);
    const timeout = setTimeout(() => {}, 60000);

    manager.register("session-1", child, {
      timeout,
      kind: "exec",
      agent: "codex",
      debug: mockDebug,
    });

    assert.equal(manager.isAlive("session-1"), true);

    clearTimeout(timeout);
  });

  await t.test("should return false for killed process", () => {
    const manager = new ProcessLifecycleManager(mockLogger as any);
    const child = createMockChild(false);
    const timeout = setTimeout(() => {}, 60000);

    manager.register("session-1", child, {
      timeout,
      kind: "exec",
      agent: "codex",
      debug: mockDebug,
    });

    manager.kill("session-1");

    assert.equal(manager.isAlive("session-1"), false);

    clearTimeout(timeout);
  });

  await t.test("should return false for unknown session", () => {
    const manager = new ProcessLifecycleManager(mockLogger as any);
    assert.equal(manager.isAlive("unknown"), false);
  });
});

test("ProcessLifecycleManager getSessionIds", async (t) => {
  await t.test("should return all registered session IDs", () => {
    const manager = new ProcessLifecycleManager(mockLogger as any);

    manager.register("session-1", createMockChild(), {
      timeout: setTimeout(() => {}, 60000),
      kind: "exec",
      agent: "codex",
      debug: mockDebug,
    });

    manager.register("session-2", createMockChild(), {
      timeout: setTimeout(() => {}, 60000),
      kind: "resume",
      agent: "claude_code",
      debug: mockDebug,
    });

    const ids = manager.getSessionIds();

    assert.equal(ids.length, 2);
    assert.ok(ids.includes("session-1"));
    assert.ok(ids.includes("session-2"));
  });
});

test("ProcessLifecycleManager clearAll", async (t) => {
  await t.test("should kill and unregister all processes", () => {
    const manager = new ProcessLifecycleManager(mockLogger as any);
    const child1 = createMockChild();
    const child2 = createMockChild();

    manager.register("session-1", child1, {
      timeout: setTimeout(() => {}, 60000),
      kind: "exec",
      agent: "codex",
      debug: mockDebug,
    });

    manager.register("session-2", child2, {
      timeout: setTimeout(() => {}, 60000),
      kind: "exec",
      agent: "codex",
      debug: mockDebug,
    });

    manager.clearAll();

    assert.equal(manager.size, 0);
    assert.equal(child1.killed, true);
    assert.equal(child2.killed, true);
  });
});

test("ProcessLifecycleManager getAgent/getDebug", async (t) => {
  await t.test("should return agent type for session", () => {
    const manager = new ProcessLifecycleManager(mockLogger as any);

    manager.register("session-1", createMockChild(), {
      timeout: setTimeout(() => {}, 60000),
      kind: "exec",
      agent: "claude_code",
      debug: mockDebug,
    });

    assert.equal(manager.getAgent("session-1"), "claude_code");
    assert.equal(manager.getAgent("unknown"), null);
  });

  await t.test("should return debug info for session", () => {
    const manager = new ProcessLifecycleManager(mockLogger as any);
    const customDebug = {
      kind: "exec",
      binary: "/usr/bin/test",
      cwd: "/tmp",
      args: [],
      envOverrides: [],
      stderrTail: () => "stderr content",
      stdoutTail: () => "stdout content",
    };

    manager.register("session-1", createMockChild(), {
      timeout: setTimeout(() => {}, 60000),
      kind: "exec",
      agent: "codex",
      debug: customDebug,
    });

    const debug = manager.getDebug("session-1");
    assert.ok(debug);
    assert.equal(debug.stderrTail(), "stderr content");
  });
});
