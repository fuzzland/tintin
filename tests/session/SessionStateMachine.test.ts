import test from "node:test";
import assert from "node:assert/strict";
import { SessionStateMachine } from "../../src/runtime/session/SessionStateMachine.js";
import type { SessionStatus } from "../../src/runtime/db.js";

// Mock logger
const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Create a mock database with in-memory session storage
function createMockDb(initialSessions: Array<{ id: string; status: SessionStatus }> = []) {
  const sessions = new Map<string, { id: string; status: SessionStatus; [key: string]: unknown }>(
    initialSessions.map((s) => [s.id, { ...s }]),
  );

  return {
    selectFrom: (table: string) => {
      if (table !== "sessions") throw new Error(`Unexpected table: ${table}`);
      return {
        select: (_columns: string[]) => ({
          where: (_col: string, _op: string, id: string) => ({
            executeTakeFirst: async () => sessions.get(id),
          }),
        }),
      };
    },
    updateTable: (table: string) => {
      if (table !== "sessions") throw new Error(`Unexpected table: ${table}`);
      return {
        set: (data: Record<string, unknown>) => ({
          where: (_col: string, _op: string, id: string) => ({
            execute: async () => {
              const session = sessions.get(id);
              if (session) {
                Object.assign(session, data);
              }
              return { numUpdatedRows: session ? BigInt(1) : BigInt(0) };
            },
          }),
        }),
      };
    },
    // Helper for tests to inspect state
    _getSessions: () => sessions,
  } as unknown as Parameters<typeof SessionStateMachine.prototype["validateTransition"]>[0] & {
    _getSessions: () => Map<string, { id: string; status: SessionStatus; [key: string]: unknown }>;
  };
}

test("SessionStateMachine validateTransition", async (t) => {
  const db = createMockDb();
  const machine = new SessionStateMachine(db as any, mockLogger as any);

  await t.test("should allow wizard -> starting", () => {
    assert.equal(machine.validateTransition("wizard", "starting"), true);
  });

  await t.test("should allow starting -> running", () => {
    assert.equal(machine.validateTransition("starting", "running"), true);
  });

  await t.test("should allow starting -> error", () => {
    assert.equal(machine.validateTransition("starting", "error"), true);
  });

  await t.test("should allow starting -> killed", () => {
    assert.equal(machine.validateTransition("starting", "killed"), true);
  });

  await t.test("should allow running -> finished", () => {
    assert.equal(machine.validateTransition("running", "finished"), true);
  });

  await t.test("should allow running -> error", () => {
    assert.equal(machine.validateTransition("running", "error"), true);
  });

  await t.test("should allow running -> killed", () => {
    assert.equal(machine.validateTransition("running", "killed"), true);
  });

  await t.test("should reject finished -> any", () => {
    assert.equal(machine.validateTransition("finished", "starting"), false);
    assert.equal(machine.validateTransition("finished", "running"), false);
    assert.equal(machine.validateTransition("finished", "error"), false);
  });

  await t.test("should reject error -> any", () => {
    assert.equal(machine.validateTransition("error", "starting"), false);
    assert.equal(machine.validateTransition("error", "running"), false);
    assert.equal(machine.validateTransition("error", "finished"), false);
  });

  await t.test("should reject killed -> any", () => {
    assert.equal(machine.validateTransition("killed", "starting"), false);
    assert.equal(machine.validateTransition("killed", "running"), false);
    assert.equal(machine.validateTransition("killed", "finished"), false);
  });

  await t.test("should reject invalid transitions", () => {
    assert.equal(machine.validateTransition("wizard", "running"), false);
    assert.equal(machine.validateTransition("wizard", "finished"), false);
    assert.equal(machine.validateTransition("starting", "finished"), false);
    assert.equal(machine.validateTransition("running", "starting"), false);
  });
});

test("SessionStateMachine getCurrentStatus", async (t) => {
  await t.test("should return current status for existing session", async () => {
    const db = createMockDb([{ id: "session-1", status: "running" }]);
    const machine = new SessionStateMachine(db as any, mockLogger as any);

    const status = await machine.getCurrentStatus("session-1");
    assert.equal(status, "running");
  });

  await t.test("should return null for non-existent session", async () => {
    const db = createMockDb();
    const machine = new SessionStateMachine(db as any, mockLogger as any);

    const status = await machine.getCurrentStatus("unknown");
    assert.equal(status, null);
  });
});

test("SessionStateMachine transition", async (t) => {
  await t.test("should transition to valid state", async () => {
    const db = createMockDb([{ id: "session-1", status: "starting" }]);
    const machine = new SessionStateMachine(db as any, mockLogger as any);

    await machine.transition("session-1", "running");

    const sessions = (db as any)._getSessions();
    assert.equal(sessions.get("session-1")?.status, "running");
  });

  await t.test("should throw for invalid transition", async () => {
    const db = createMockDb([{ id: "session-1", status: "starting" }]);
    const machine = new SessionStateMachine(db as any, mockLogger as any);

    await assert.rejects(
      () => machine.transition("session-1", "finished"),
      /Invalid session state transition/,
    );
  });

  await t.test("should throw for non-existent session", async () => {
    const db = createMockDb();
    const machine = new SessionStateMachine(db as any, mockLogger as any);

    await assert.rejects(
      () => machine.transition("unknown", "running"),
      /not found/,
    );
  });

  await t.test("should include metadata in update", async () => {
    const db = createMockDb([{ id: "session-1", status: "starting" }]);
    const machine = new SessionStateMachine(db as any, mockLogger as any);

    await machine.transition("session-1", "running", { pid: 12345 });

    const sessions = (db as any)._getSessions();
    const session = sessions.get("session-1");
    assert.equal(session?.status, "running");
    assert.equal(session?.pid, 12345);
  });

  await t.test("should auto-set finished_at for terminal states", async () => {
    const db = createMockDb([{ id: "session-1", status: "running" }]);
    const machine = new SessionStateMachine(db as any, mockLogger as any);

    await machine.transition("session-1", "finished");

    const sessions = (db as any)._getSessions();
    const session = sessions.get("session-1");
    assert.equal(session?.status, "finished");
    assert.ok(session?.finished_at, "finished_at should be set");
  });

  await t.test("should skip validation when skipValidation is true", async () => {
    const db = createMockDb([{ id: "session-1", status: "finished" }]);
    const machine = new SessionStateMachine(db as any, mockLogger as any);

    // This would normally fail (finished -> error is invalid)
    await machine.transition("session-1", "error", undefined, true);

    const sessions = (db as any)._getSessions();
    assert.equal(sessions.get("session-1")?.status, "error");
  });
});

test("SessionStateMachine isTerminal", async (t) => {
  await t.test("should return true for terminal states", async () => {
    const db = createMockDb([
      { id: "s1", status: "finished" },
      { id: "s2", status: "error" },
      { id: "s3", status: "killed" },
    ]);
    const machine = new SessionStateMachine(db as any, mockLogger as any);

    assert.equal(await machine.isTerminal("s1"), true);
    assert.equal(await machine.isTerminal("s2"), true);
    assert.equal(await machine.isTerminal("s3"), true);
  });

  await t.test("should return false for non-terminal states", async () => {
    const db = createMockDb([
      { id: "s1", status: "starting" },
      { id: "s2", status: "running" },
      { id: "s3", status: "wizard" },
    ]);
    const machine = new SessionStateMachine(db as any, mockLogger as any);

    assert.equal(await machine.isTerminal("s1"), false);
    assert.equal(await machine.isTerminal("s2"), false);
    assert.equal(await machine.isTerminal("s3"), false);
  });

  await t.test("should return false for non-existent session", async () => {
    const db = createMockDb();
    const machine = new SessionStateMachine(db as any, mockLogger as any);

    assert.equal(await machine.isTerminal("unknown"), false);
  });
});

test("SessionStateMachine isActive", async (t) => {
  await t.test("should return true for starting and running", async () => {
    const db = createMockDb([
      { id: "s1", status: "starting" },
      { id: "s2", status: "running" },
    ]);
    const machine = new SessionStateMachine(db as any, mockLogger as any);

    assert.equal(await machine.isActive("s1"), true);
    assert.equal(await machine.isActive("s2"), true);
  });

  await t.test("should return false for terminal and wizard states", async () => {
    const db = createMockDb([
      { id: "s1", status: "wizard" },
      { id: "s2", status: "finished" },
      { id: "s3", status: "error" },
      { id: "s4", status: "killed" },
    ]);
    const machine = new SessionStateMachine(db as any, mockLogger as any);

    assert.equal(await machine.isActive("s1"), false);
    assert.equal(await machine.isActive("s2"), false);
    assert.equal(await machine.isActive("s3"), false);
    assert.equal(await machine.isActive("s4"), false);
  });

  await t.test("should return false for non-existent session", async () => {
    const db = createMockDb();
    const machine = new SessionStateMachine(db as any, mockLogger as any);

    assert.equal(await machine.isActive("unknown"), false);
  });
});

test("SessionStateMachine forceError", async (t) => {
  await t.test("should force transition to error state", async () => {
    const db = createMockDb([{ id: "session-1", status: "running" }]);
    const machine = new SessionStateMachine(db as any, mockLogger as any);

    await machine.forceError("session-1", 1);

    const sessions = (db as any)._getSessions();
    const session = sessions.get("session-1");
    assert.equal(session?.status, "error");
    assert.equal(session?.exit_code, 1);
    assert.equal(session?.pid, null);
  });

  await t.test("should work even from terminal states", async () => {
    const db = createMockDb([{ id: "session-1", status: "finished" }]);
    const machine = new SessionStateMachine(db as any, mockLogger as any);

    // This should not throw because forceError skips validation
    await machine.forceError("session-1");

    const sessions = (db as any)._getSessions();
    assert.equal(sessions.get("session-1")?.status, "error");
  });

  await t.test("should set exit_code to null when not provided", async () => {
    const db = createMockDb([{ id: "session-1", status: "running" }]);
    const machine = new SessionStateMachine(db as any, mockLogger as any);

    await machine.forceError("session-1");

    const sessions = (db as any)._getSessions();
    assert.equal(sessions.get("session-1")?.exit_code, null);
  });
});
