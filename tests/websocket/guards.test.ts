import test from "node:test";
import assert from "node:assert/strict";
import { requireCloudService } from "../../src/runtime/websocket/guards.js";
import type { WebSocketManager } from "../../src/runtime/websocket/manager.js";

function createMockWsManager(): WebSocketManager {
  const sentMessages: Array<{ connId: string; message: unknown }> = [];
  return {
    sendToConnection: (connId: string, message: unknown) => {
      sentMessages.push({ connId, message });
      return true;
    },
    _sentMessages: sentMessages,
  } as unknown as WebSocketManager;
}

test("requireCloudService returns false and sends error when service is null", () => {
  const wsManager = createMockWsManager();
  const result = requireCloudService(wsManager, "conn-1", null);

  assert.equal(result, false);
  assert.equal((wsManager as any)._sentMessages.length, 1);
  assert.equal((wsManager as any)._sentMessages[0].message.type, "error");
  assert.equal((wsManager as any)._sentMessages[0].message.message, "Cloud run is not enabled");
});

test("requireCloudService returns true when service exists", () => {
  const wsManager = createMockWsManager();
  const mockService = { handleCloudRun: () => {} };
  const result = requireCloudService(wsManager, "conn-1", mockService);

  assert.equal(result, true);
  assert.equal((wsManager as any)._sentMessages.length, 0);
});
