/**
 * ToolCallManager - Manages pending tool calls queue for pairing calls with outputs.
 *
 * Tool calls and their outputs arrive as separate JSONL events. This manager
 * maintains a FIFO queue per session to pair tool_call fragments with their
 * corresponding tool_output fragments.
 */
export class ToolCallManager {
  private readonly pending = new Map<string, string[]>();

  /**
   * Push a tool call text to the queue for a session.
   */
  push(sessionId: string, callText: string): void {
    const q = this.pending.get(sessionId) ?? [];
    q.push(callText);
    this.pending.set(sessionId, q);
  }

  /**
   * Shift (remove and return) the oldest tool call from the queue.
   * Returns null if the queue is empty or doesn't exist.
   */
  shift(sessionId: string): string | null {
    const q = this.pending.get(sessionId);
    if (!q || q.length === 0) return null;
    const callText = q.shift()!;
    if (q.length === 0) {
      this.pending.delete(sessionId);
    }
    return callText;
  }

  /**
   * Check if a session has pending tool calls.
   */
  hasPending(sessionId: string): boolean {
    const q = this.pending.get(sessionId);
    return q !== undefined && q.length > 0;
  }

  /**
   * Get the number of pending tool calls for a session.
   */
  pendingCount(sessionId: string): number {
    const q = this.pending.get(sessionId);
    return q ? q.length : 0;
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

  /**
   * Get all session IDs with pending tool calls.
   */
  getSessionIds(): string[] {
    return Array.from(this.pending.keys());
  }
}
