/**
 * PlanUpdateHandler - Manages plan update parsing and suppression of plan tool outputs.
 *
 * When the agent calls the update_plan tool, we emit a plan_update fragment and
 * remember the call ID. When the corresponding tool output arrives, we suppress
 * it to avoid duplicate/noisy output.
 */
export class PlanUpdateHandler {
  private readonly planCallIds = new Map<string, Set<string>>();

  /**
   * Remember a plan call ID for later suppression of its output.
   */
  rememberPlanCallId(sessionId: string, callId: string): void {
    const set = this.planCallIds.get(sessionId) ?? new Set<string>();
    set.add(callId);
    this.planCallIds.set(sessionId, set);
  }

  /**
   * Check and consume a plan call ID. Returns true if the call ID was remembered
   * (meaning its output should be suppressed).
   */
  consumePlanCallId(sessionId: string, callId: string): boolean {
    if (!callId) return false;
    const set = this.planCallIds.get(sessionId);
    if (!set) return false;
    const had = set.delete(callId);
    if (set.size === 0) {
      this.planCallIds.delete(sessionId);
    }
    return had;
  }

  /**
   * Clear all plan call IDs for a session.
   */
  clear(sessionId: string): void {
    this.planCallIds.delete(sessionId);
  }

  /**
   * Clear all sessions except those in the keep set.
   */
  clearExcept(keepIds: Set<string>): void {
    for (const id of this.planCallIds.keys()) {
      if (!keepIds.has(id)) {
        this.planCallIds.delete(id);
      }
    }
  }

  /**
   * Parse a plan update from a tool call.
   * Returns the parsed plan if the tool is "update_plan" with valid arguments.
   */
  parsePlanUpdateFromToolCall(
    name: unknown,
    args: unknown,
  ): { plan: Array<{ step: string; status: string }>; explanation?: string } | null {
    if (typeof name !== "string" || name.trim().toLowerCase() !== "update_plan") return null;
    const parsedArgs = parseJsonObject(args);
    if (!parsedArgs) return null;
    return parsePlanUpdatePayload(parsedArgs);
  }

  /**
   * Check if an event's tool output should be suppressed because it's for a plan call.
   */
  shouldSuppressPlanOutput(obj: unknown, sessionId: string): boolean {
    if (!obj || typeof obj !== "object") return false;
    const type = (obj as { type?: unknown }).type;

    if (type === "response_item") {
      const payload = (obj as { payload?: unknown }).payload;
      if (!payload || typeof payload !== "object") return false;
      if ((payload as { type?: unknown }).type === "function_call_output") {
        const callId = stringOrEmpty((payload as { call_id?: unknown }).call_id);
        return this.consumePlanCallId(sessionId, callId);
      }
      return false;
    }

    if (type === "function_call_output") {
      const callId = stringOrEmpty((obj as { call_id?: unknown }).call_id);
      return this.consumePlanCallId(sessionId, callId);
    }

    return false;
  }

  /**
   * Parse a plan update from a JSONL event object.
   * Handles both top-level and nested response_item structures.
   */
  parsePlanUpdate(
    obj: unknown,
    sessionId: string,
  ): { kind: "plan_update"; plan: Array<{ step: string; status: string }>; explanation?: string } | null {
    if (!obj || typeof obj !== "object") return null;
    const type = (obj as { type?: unknown }).type;

    if (type === "response_item") {
      const payload = (obj as { payload?: unknown }).payload;
      if (!payload || typeof payload !== "object") return null;
      const payloadType = (payload as { type?: unknown }).type;
      if (payloadType === "function_call" || payloadType === "custom_tool_call") {
        const parsed = this.parsePlanUpdateFromToolCall(
          (payload as { name?: unknown }).name,
          payloadType === "function_call"
            ? (payload as { arguments?: unknown }).arguments
            : (payload as { input?: unknown }).input,
        );
        if (parsed) {
          const callId = stringOrEmpty((payload as { call_id?: unknown }).call_id);
          if (callId) this.rememberPlanCallId(sessionId, callId);
          return { kind: "plan_update", plan: parsed.plan, explanation: parsed.explanation };
        }
      }
      return null;
    }

    if (type === "function_call" || type === "custom_tool_call") {
      const parsed = this.parsePlanUpdateFromToolCall(
        (obj as { name?: unknown }).name,
        type === "function_call" ? (obj as { arguments?: unknown }).arguments : (obj as { input?: unknown }).input,
      );
      if (parsed) {
        const callId = stringOrEmpty((obj as { call_id?: unknown }).call_id || (obj as { id?: unknown }).id);
        if (callId) this.rememberPlanCallId(sessionId, callId);
        return { kind: "plan_update", plan: parsed.plan, explanation: parsed.explanation };
      }
    }

    return null;
  }
}

// Helper functions (private to this module)

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Parse a plan update payload object.
 */
export function parsePlanUpdatePayload(
  payload: Record<string, unknown>,
): { plan: Array<{ step: string; status: string }>; explanation?: string } | null {
  const rawPlan = Array.isArray(payload.plan) ? payload.plan : [];
  const plan = rawPlan
    .map((p): { step: string; status: string } | null => {
      if (typeof p === "string") {
        const step = p.trim();
        return step ? { step, status: "pending" } : null;
      }
      if (!p || typeof p !== "object") return null;
      const step = stringOrEmpty((p as { step?: unknown }).step).trim();
      if (!step) return null;
      const status = stringOrEmpty((p as { status?: unknown }).status).trim() || "pending";
      return { step, status };
    })
    .filter((p): p is { step: string; status: string } => Boolean(p));

  const explanation = stringOrEmpty(payload.explanation).trim();
  if (plan.length === 0 && !explanation) return null;
  return { plan, explanation: explanation || undefined };
}
