import type { PendingToolCall } from "./types.js";

/**
 * ToolCallManager - Manages pending tool calls queue for pairing calls with outputs.
 *
 * Tool calls and their outputs arrive as separate JSONL events. This manager
 * maintains a FIFO queue per session to pair tool_call fragments with their
 * corresponding tool_output fragments.
 */
export class ToolCallManager {
  private readonly pending = new Map<string, PendingToolCall[]>();

  /**
   * Push a tool call to the queue for a session.
   */
  push(sessionId: string, call: PendingToolCall): void {
    const q = this.pending.get(sessionId) ?? [];
    q.push(call);
    this.pending.set(sessionId, q);
  }

  /**
   * Shift (remove and return) the oldest tool call from the queue.
   * Returns null if the queue is empty or doesn't exist.
   */
  shift(sessionId: string): PendingToolCall | null {
    const q = this.pending.get(sessionId);
    if (!q || q.length === 0) return null;
    const call = q.shift()!;
    if (q.length === 0) {
      this.pending.delete(sessionId);
    }
    return call;
  }

  /**
   * Clear all pending tool calls for a specific session.
   */
  clear(sessionId: string): void {
    this.pending.delete(sessionId);
  }

  /**
   * Clear all sessions except those in the keep set.
   * Used for cleanup when sessions finish.
   */
  clearExcept(keepIds: Set<string>): void {
    for (const id of this.pending.keys()) {
      if (!keepIds.has(id)) {
        this.pending.delete(id);
      }
    }
  }

}
