import test from "node:test";
import assert from "node:assert/strict";
import { PlanUpdateHandler, parsePlanUpdatePayload } from "../../src/runtime/streamer/PlanUpdateHandler.js";

test("PlanUpdateHandler rememberPlanCallId/consumePlanCallId", async (t) => {
  await t.test("should remember and consume plan call IDs", () => {
    const handler = new PlanUpdateHandler();
    handler.rememberPlanCallId("session-1", "call-123");

    assert.equal(handler.consumePlanCallId("session-1", "call-123"), true);
    assert.equal(handler.consumePlanCallId("session-1", "call-123"), false); // Already consumed
  });

  await t.test("should return false for unknown call ID", () => {
    const handler = new PlanUpdateHandler();
    assert.equal(handler.consumePlanCallId("session-1", "unknown"), false);
  });

  await t.test("should return false for empty call ID", () => {
    const handler = new PlanUpdateHandler();
    handler.rememberPlanCallId("session-1", "call-123");
    assert.equal(handler.consumePlanCallId("session-1", ""), false);
  });
});

test("PlanUpdateHandler parsePlanUpdateFromToolCall", async (t) => {
  await t.test("should parse valid update_plan call", () => {
    const handler = new PlanUpdateHandler();
    const result = handler.parsePlanUpdateFromToolCall(
      "update_plan",
      { plan: [{ step: "Step 1", status: "completed" }], explanation: "Test" }
    );

    assert.ok(result);
    assert.equal(result!.plan.length, 1);
    assert.equal(result!.plan[0]!.step, "Step 1");
    assert.equal(result!.plan[0]!.status, "completed");
    assert.equal(result!.explanation, "Test");
  });

  await t.test("should return null for non-update_plan tool", () => {
    const handler = new PlanUpdateHandler();
    const result = handler.parsePlanUpdateFromToolCall(
      "other_tool",
      { plan: [{ step: "Step 1", status: "completed" }] }
    );

    assert.equal(result, null);
  });

  await t.test("should parse JSON string arguments", () => {
    const handler = new PlanUpdateHandler();
    const result = handler.parsePlanUpdateFromToolCall(
      "update_plan",
      JSON.stringify({ plan: ["Step 1", "Step 2"] })
    );

    assert.ok(result);
    assert.equal(result!.plan.length, 2);
    assert.equal(result!.plan[0]!.status, "pending"); // Default status
  });
});

test("PlanUpdateHandler shouldSuppressPlanOutput", async (t) => {
  await t.test("should suppress output for remembered plan call", () => {
    const handler = new PlanUpdateHandler();
    handler.rememberPlanCallId("session-1", "call-123");

    const obj = {
      type: "function_call_output",
      call_id: "call-123",
    };

    assert.equal(handler.shouldSuppressPlanOutput(obj, "session-1"), true);
  });

  await t.test("should not suppress output for unknown call", () => {
    const handler = new PlanUpdateHandler();

    const obj = {
      type: "function_call_output",
      call_id: "unknown-call",
    };

    assert.equal(handler.shouldSuppressPlanOutput(obj, "session-1"), false);
  });

  await t.test("should handle response_item wrapper", () => {
    const handler = new PlanUpdateHandler();
    handler.rememberPlanCallId("session-1", "call-123");

    const obj = {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-123",
      },
    };

    assert.equal(handler.shouldSuppressPlanOutput(obj, "session-1"), true);
  });
});

test("PlanUpdateHandler parsePlanUpdate", async (t) => {
  await t.test("should parse function_call event", () => {
    const handler = new PlanUpdateHandler();

    const obj = {
      type: "function_call",
      name: "update_plan",
      arguments: { plan: [{ step: "Step 1", status: "in_progress" }] },
      call_id: "call-123",
    };

    const result = handler.parsePlanUpdate(obj, "session-1");

    assert.ok(result);
    assert.equal(result.kind, "plan_update");
    assert.equal(result.plan.length, 1);
  });

  await t.test("should parse response_item with function_call", () => {
    const handler = new PlanUpdateHandler();

    const obj = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "update_plan",
        arguments: { plan: [{ step: "Step 1", status: "completed" }] },
        call_id: "call-456",
      },
    };

    const result = handler.parsePlanUpdate(obj, "session-1");

    assert.ok(result);
    assert.equal(result.kind, "plan_update");
  });

  await t.test("should return null for non-plan events", () => {
    const handler = new PlanUpdateHandler();

    const obj = {
      type: "function_call",
      name: "other_tool",
      arguments: { foo: "bar" },
    };

    const result = handler.parsePlanUpdate(obj, "session-1");
    assert.equal(result, null);
  });
});

test("parsePlanUpdatePayload", async (t) => {
  await t.test("should parse plan with object items", () => {
    const result = parsePlanUpdatePayload({
      plan: [
        { step: "Step 1", status: "completed" },
        { step: "Step 2", status: "in_progress" },
        { step: "Step 3", status: "pending" },
      ],
    });

    assert.ok(result);
    assert.equal(result!.plan.length, 3);
    assert.equal(result!.plan[0]!.step, "Step 1");
    assert.equal(result!.plan[0]!.status, "completed");
  });

  await t.test("should parse plan with string items", () => {
    const result = parsePlanUpdatePayload({
      plan: ["Step 1", "Step 2"],
    });

    assert.ok(result);
    assert.equal(result!.plan.length, 2);
    assert.equal(result!.plan[0]!.status, "pending"); // Default
  });

  await t.test("should include explanation if present", () => {
    const result = parsePlanUpdatePayload({
      plan: [{ step: "Step 1", status: "pending" }],
      explanation: "This is the plan",
    });

    assert.ok(result);
    assert.equal(result!.explanation, "This is the plan");
  });

  await t.test("should return null for empty plan without explanation", () => {
    const result = parsePlanUpdatePayload({ plan: [] });
    assert.equal(result, null);
  });

  await t.test("should skip invalid plan items", () => {
    const result = parsePlanUpdatePayload({
      plan: [
        { step: "Valid step", status: "pending" },
        { step: "", status: "pending" }, // Empty step
        null,
        undefined,
        "Another valid step",
      ],
    });

    assert.ok(result);
    assert.equal(result!.plan.length, 2);
  });
});

test("PlanUpdateHandler clear/clearExcept", async (t) => {
  await t.test("should clear specific session", () => {
    const handler = new PlanUpdateHandler();
    handler.rememberPlanCallId("session-1", "call-1");
    handler.rememberPlanCallId("session-2", "call-2");

    handler.clear("session-1");

    assert.equal(handler.consumePlanCallId("session-1", "call-1"), false);
    assert.equal(handler.consumePlanCallId("session-2", "call-2"), true);
  });

  await t.test("should clear except specified sessions", () => {
    const handler = new PlanUpdateHandler();
    handler.rememberPlanCallId("session-1", "call-1");
    handler.rememberPlanCallId("session-2", "call-2");
    handler.rememberPlanCallId("session-3", "call-3");

    handler.clearExcept(new Set(["session-2"]));

    assert.equal(handler.consumePlanCallId("session-1", "call-1"), false);
    assert.equal(handler.consumePlanCallId("session-2", "call-2"), true);
    assert.equal(handler.consumePlanCallId("session-3", "call-3"), false);
  });
});
