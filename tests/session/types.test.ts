import test from "node:test";
import assert from "node:assert/strict";
import { VALID_TRANSITIONS, isTerminalStatus } from "../../src/runtime/session/types.js";

test("VALID_TRANSITIONS", async (t) => {
  await t.test("should allow starting -> running transition", () => {
    assert.ok(VALID_TRANSITIONS.starting.includes("running"));
  });

  await t.test("should allow starting -> error transition", () => {
    assert.ok(VALID_TRANSITIONS.starting.includes("error"));
  });

  await t.test("should allow starting -> killed transition", () => {
    assert.ok(VALID_TRANSITIONS.starting.includes("killed"));
  });

  await t.test("should allow running -> finished transition", () => {
    assert.ok(VALID_TRANSITIONS.running.includes("finished"));
  });

  await t.test("should allow running -> error transition", () => {
    assert.ok(VALID_TRANSITIONS.running.includes("error"));
  });

  await t.test("should allow running -> killed transition", () => {
    assert.ok(VALID_TRANSITIONS.running.includes("killed"));
  });

  await t.test("should have no transitions from finished", () => {
    assert.deepEqual(VALID_TRANSITIONS.finished, []);
  });

  await t.test("should have no transitions from error", () => {
    assert.deepEqual(VALID_TRANSITIONS.error, []);
  });

  await t.test("should have no transitions from killed", () => {
    assert.deepEqual(VALID_TRANSITIONS.killed, []);
  });

  await t.test("should allow wizard -> starting transition", () => {
    assert.ok(VALID_TRANSITIONS.wizard.includes("starting"));
  });
});

test("isTerminalStatus", async (t) => {
  await t.test("should return true for finished", () => {
    assert.equal(isTerminalStatus("finished"), true);
  });

  await t.test("should return true for error", () => {
    assert.equal(isTerminalStatus("error"), true);
  });

  await t.test("should return true for killed", () => {
    assert.equal(isTerminalStatus("killed"), true);
  });

  await t.test("should return false for starting", () => {
    assert.equal(isTerminalStatus("starting"), false);
  });

  await t.test("should return false for running", () => {
    assert.equal(isTerminalStatus("running"), false);
  });

  await t.test("should return false for wizard", () => {
    assert.equal(isTerminalStatus("wizard"), false);
  });
});
