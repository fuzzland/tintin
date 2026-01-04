#!/usr/bin/env node
const process = require("node:process");

const url = process.env.TINTIN_AGENT_URL ?? "";
const token = process.env.TINTIN_AGENT_TOKEN ?? "";
const agent = process.env.TINTIN_AGENT_AGENT ?? "";
const session = process.env.TINTIN_AGENT_SESSION ?? "";

const flushMs = Number(process.env.TINTIN_AGENT_FLUSH_MS ?? "200");
const maxChunkBytes = Number(process.env.TINTIN_AGENT_MAX_CHUNK_BYTES ?? "65536");
const maxQueueBytes = Number(process.env.TINTIN_AGENT_MAX_QUEUE_BYTES ?? String(4 * 1024 * 1024));

if (!url || !token) {
  const missing = !url ? "TINTIN_AGENT_URL" : "TINTIN_AGENT_TOKEN";
  console.error(`[tintin-agent] missing ${missing}; draining stdout only`);
  process.stdin.resume();
  process.stdin.on("data", () => {});
  process.stdin.on("end", () => process.exit(0));
  return;
}

const headersBase = {
  "content-type": "text/plain",
  authorization: `Bearer ${token}`,
  ...(agent ? { "x-tintin-agent": agent } : {}),
  ...(session ? { "x-tintin-session": session } : {}),
};

let buffer = "";
let flushTimer = null;
let sending = false;
let ended = false;
const queue = [];
let queuedBytes = 0;

const enqueue = (chunk) => {
  if (!chunk) return;
  if (queuedBytes + chunk.length > maxQueueBytes) {
    // Drop oldest chunk to keep moving and avoid blocking codex.
    const dropped = queue.shift();
    if (dropped) queuedBytes -= dropped.length;
  }
  queue.push(chunk);
  queuedBytes += chunk.length;
  void sendLoop();
};

const flush = () => {
  if (!buffer) return;
  enqueue(buffer);
  buffer = "";
};

const scheduleFlush = () => {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, Math.max(10, flushMs));
};

const sendLoop = async () => {
  if (sending) return;
  sending = true;
  while (queue.length > 0) {
    const chunk = queue.shift();
    if (!chunk) continue;
    queuedBytes -= chunk.length;
    try {
      await fetch(url, { method: "POST", headers: headersBase, body: chunk });
    } catch (err) {
      console.error(`[tintin-agent] send failed: ${String(err)}`);
      // Best effort: continue draining to avoid blocking.
    }
  }
  sending = false;
  if (ended && queue.length === 0) process.exit(0);
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (!chunk) return;
  buffer += chunk;
  if (buffer.length >= maxChunkBytes) flush();
  else scheduleFlush();
});

process.stdin.on("end", () => {
  ended = true;
  flush();
  void sendLoop();
});
