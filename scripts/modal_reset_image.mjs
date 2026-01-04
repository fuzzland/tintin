import { ModalClient } from "modal";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const image = process.env.MODAL_IMAGE || "shouc/tintin-dev:latest";
const appName = process.env.MODAL_APP || "tintin-demo";
const environment = process.env.MODAL_ENV || "";
const tokenId = process.env.MODAL_TOKEN_ID || "";
const tokenSecret = process.env.MODAL_TOKEN_SECRET || "";
const timeoutMs = Number.parseInt(process.env.MODAL_TIMEOUT_MS || "", 10);
const idleTimeoutMs = Number.parseInt(process.env.MODAL_IDLE_TIMEOUT_MS || "", 10);

if (!tokenId || !tokenSecret) {
  console.error("Missing MODAL_TOKEN_ID or MODAL_TOKEN_SECRET in environment.");
  process.exit(1);
}

const modal = new ModalClient({
  tokenId,
  tokenSecret,
  environment: environment || undefined,
});

const app = await modal.apps.fromName(appName, {
  environment: environment || undefined,
  createIfMissing: true,
});

const demoDir = path.dirname(fileURLToPath(import.meta.url));
const imageCachePath = path.join(demoDir, ".modal-images.json");

async function loadImageCache() {
  try {
    const raw = await readFile(imageCachePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string" && id.length > 0) : [];
  } catch {
    return [];
  }
}

async function saveImageCache(ids) {
  await writeFile(imageCachePath, JSON.stringify(ids, null, 2), "utf8");
}

async function maybeDeleteLastImage() {
  if (!process.argv.includes("--delete-last-image")) return;
  const ids = await loadImageCache();
  if (ids.length === 0) {
    console.log("No cached Modal images to delete.");
    return;
  }
  const lastId = ids.pop();
  try {
    await modal.images.delete(lastId);
    console.log("Deleted Modal image:", lastId);
    await saveImageCache(ids);
  } catch (e) {
    console.warn("Failed to delete Modal image:", lastId, String(e));
    await saveImageCache([...ids, lastId]);
  }
}

await maybeDeleteLastImage();

const imageObj = modal.images.fromRegistry(image);
const builtImage = await imageObj.build(app);
if (builtImage.imageId) {
  const existing = await loadImageCache();
  const next = Array.from(new Set([...existing, builtImage.imageId]));
  await saveImageCache(next);
}

const params = {
  encryptedPorts: [8080, 9223],
};
if (Number.isFinite(timeoutMs) && timeoutMs > 0) params.timeoutMs = timeoutMs;
if (Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0) params.idleTimeoutMs = idleTimeoutMs;

const sandbox = await modal.sandboxes.create(app, builtImage, params);

// Ensure start.sh is running inside the sandbox
await sandbox.exec(["/bin/sh", "-lc", "sudo -u ubuntu /home/ubuntu/start.sh > /home/ubuntu/start.log 2>&1 &"], {
  timeoutMs: 10_000,
  stdout: "ignore",
  stderr: "ignore",
  mode: "text",
});

const tunnels = await sandbox.tunnels(60_000);
const vsCode = tunnels[8080];
const cdp = tunnels[9223];

console.log("Sandbox ID:", sandbox.sandboxId);
if (vsCode) {
  console.log("VS Code URL:", vsCode.url);
}
if (cdp) {
  console.log("CDP TLS:", cdp.tlsSocket[0] + ":" + cdp.tlsSocket[1]);
  console.log("CDP WSS:", `wss://${cdp.tlsSocket[0]}:${cdp.tlsSocket[1]}`);
}

const shutdown = async () => {
  console.log("\nShutting down sandbox...");
  await sandbox.terminate().catch(() => {});
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await new Promise(() => {});