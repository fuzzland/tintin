import type http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db.js";
import type { Logger } from "../../log.js";
import type { CloudManager } from "../../cloud/manager.js";
import type { WebSocketManager } from "../../websocket/manager.js";
import type { SessionRow } from "../../store.js";
import { nowMs, sleep } from "../../util.js";
import { parseAgentMeta, readHeader, readRequestBody, sendJson, sendText } from "../httpUtils.js";
import { buildLocalSiteUrl, buildNginxServerBlock } from "../deployUtils.js";
import { safeExtractTar, runCommand, writeRequestToFile } from "../fileOps.js";
import {
  createCodeRegistryEntry,
  createDynamicDeployEntry,
  createSiteRegistryEntry,
  createStaticDeployEntry,
  getDynamicDeployByIdx,
  getOrCreateIdentity,
  getStaticDeployByIdx,
  ignoreCodeRegistryEntry,
  ignoreSiteRegistryEntry,
  listCodeRegistryEntries,
  listDynamicDeploys,
  listSiteRegistryEntries,
  listStaticDeploys,
  setStaticDeployActive,
  updateDynamicDeployEntry,
  updateStaticDeployEntry,
} from "../../cloud/store.js";
import { createSession } from "../../store.js";

const STATIC_SITE_ROOT = "/mnt/data/sites";
const NGINX_CONF_DIR = "/etc/nginx/conf.d";
const DYNAMIC_DEPLOY_ROOT = "/mnt/data/deploys/dynamic";
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

type AgentRouteDeps = {
  config: AppConfig;
  db: Db;
  logger: Logger;
  cloudManager: CloudManager | null;
  wsManager: WebSocketManager | null;
};

function normalizeSetupList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  return [];
}

function normalizeIgnoreList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  return [];
}

function inferPortFromStartup(startup: string): number {
  const portFromEnv = startup.match(/\bPORT\s*=\s*(\d{2,5})\b/);
  if (portFromEnv) return Number(portFromEnv[1]);
  const portFlag = startup.match(/--port(?:=|\s+)(\d{2,5})/);
  if (portFlag) return Number(portFlag[1]);
  const shortFlag = startup.match(/\s-p\s+(\d{2,5})/);
  if (shortFlag) return Number(shortFlag[1]);
  return 3000;
}

async function resolveModalTunnelUrl(sandbox: any, port: number): Promise<string> {
  if (!sandbox) return "";
  const maxAttempts = 20;
  const delayMs = 2000;
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      const tunnels = (await sandbox.tunnels(5_000)) as Record<string | number, { url?: string } | undefined>;
      const tunnel = tunnels[port];
      if (tunnel?.url) return tunnel.url;
    } catch {
      // ignore
    }
    await sleep(delayMs);
  }
  return "";
}

const resolveAgentContext = async (
  deps: AgentRouteDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts?: { sessionId?: string },
): Promise<{ sessionId: string; identityId: string } | null> => {
  if (!deps.cloudManager || !deps.config.cloud?.enabled) {
    sendText(res, 404, "cloud not enabled");
    return null;
  }
  const sessionId =
    opts?.sessionId ??
    readHeader(req, "x-tintin-session") ??
    readHeader(req, "x-tintin-agent-session") ??
    "";
  if (!sessionId) {
    sendText(res, 400, "missing session id");
    return null;
  }
  const authHeader = readHeader(req, "authorization");
  const tokenHeader = readHeader(req, "x-tintin-agent-token");
  const token =
    authHeader && authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice("bearer ".length).trim()
      : tokenHeader ?? "";
  if (!token || !deps.cloudManager.verifyAgentToken(sessionId, token)) {
    sendText(res, 403, "forbidden");
    return null;
  }
  const sessionRow = await deps.db
    .selectFrom("sessions")
    .select(["platform", "workspace_id", "created_by_user_id"])
    .where("id", "=", sessionId)
    .executeTakeFirst();
  if (!sessionRow) {
    sendText(res, 404, "session not found");
    return null;
  }
  const identity = await getOrCreateIdentity(deps.db, {
    platform: sessionRow.platform as "telegram" | "slack",
    workspaceId: sessionRow.workspace_id || null,
    userId: sessionRow.created_by_user_id,
  });
  return { sessionId, identityId: identity.id };
};

export async function handleAgentRoutes(params: {
  deps: AgentRouteDeps;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  pathname: string;
  pathParts: string[];
}): Promise<boolean> {
  const { deps, req, res, url, pathname, pathParts } = params;
  const { config, db, logger } = deps;

  if (pathParts[0] !== "api" || pathParts[1] !== "cloud" || pathParts[2] !== "agent") return false;

  if (pathParts[3] === "e2e-token") {
    if (req.method !== "POST") {
      sendText(res, 404, "not found");
      return true;
    }
    if (process.env.TINTIN_E2E !== "1") {
      sendText(res, 404, "not found");
      return true;
    }
    const raw = await readRequestBody(req);
    let body: any = {};
    if (raw && raw.trim().length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        sendText(res, 400, "invalid json");
        return true;
      }
    }
    if (!deps.cloudManager || !config.cloud?.enabled) {
      sendText(res, 404, "cloud not enabled");
      return true;
    }
    const now = nowMs();
    const sessionId = crypto.randomUUID();
    const platform = typeof body.platform === "string" ? body.platform : "slack";
    const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id : "e2e";
    const userId = typeof body.user_id === "string" ? body.user_id : "e2e-user";
    const projectPath = typeof body.project_path === "string" ? body.project_path : process.cwd();
    const sessionRow: SessionRow = {
      id: sessionId,
      agent: "codex",
      platform,
      workspace_id: workspaceId,
      chat_id: `e2e-${sessionId.slice(0, 8)}`,
      space_id: workspaceId,
      space_emoji: null,
      created_by_user_id: userId,
      project_id: "e2e-project",
      project_path_resolved: projectPath,
      codex_session_id: null,
      browserbase_session_id: null,
      hyperbrowser_session_id: null,
      codex_cwd: projectPath,
      status: "running",
      pid: null,
      exit_code: null,
      started_at: now,
      finished_at: null,
      created_at: now,
      updated_at: now,
      last_user_message_at: now,
      language: "en",
    };
    await createSession(db, sessionRow);
    const token = deps.cloudManager.issueAgentTokenForSession(sessionId);
    sendJson(res, 200, { sessionId, token });
    return true;
  }

  if (pathParts[3] === "logs") {
    if (req.method !== "POST") {
      sendText(res, 404, "not found");
      return true;
    }
    const sessionId = pathParts[4] ?? "";
    const ctx = await resolveAgentContext(deps, req, res, { sessionId });
    if (!ctx) return true;
    const payload = await readRequestBody(req);
    if (!payload) {
      sendText(res, 204, "ok");
      return true;
    }
    const logPath = await deps.cloudManager!.getOrCreateAgentLogPath(ctx.sessionId);
    if (!logPath) {
      sendText(res, 500, "log path unavailable");
      return true;
    }
    await appendFile(logPath, payload);
    sendText(res, 200, "ok");
    return true;
  }

  const ctx = await resolveAgentContext(deps, req, res);
  if (!ctx) return true;

  const command = pathParts[3] ?? "";
  const subcommand = pathParts[4] ?? "";

  const emitAgentEvent = (payload: {
    command: string;
    subcommand: string;
    request: {
      method: string;
      path: string;
      query?: Record<string, string>;
      body?: unknown;
      meta?: unknown;
      upload_bytes?: number;
    };
    response: {
      status: number;
      body?: unknown;
      text?: string;
      error?: string;
    };
  }) => {
    if (!deps.wsManager) return;
    deps.wsManager.broadcastToSession(ctx.sessionId, {
      type: "agent_event",
      sessionId: ctx.sessionId,
      command: payload.command,
      subcommand: payload.subcommand,
      request: payload.request,
      response: payload.response,
    });
  };

  const sendAgentJson = (
    status: number,
    body: unknown,
    request: {
      method: string;
      path: string;
      query?: Record<string, string>;
      body?: unknown;
      meta?: unknown;
      upload_bytes?: number;
    },
  ) => {
    sendJson(res, status, body);
    emitAgentEvent({
      command,
      subcommand,
      request,
      response: { status, body },
    });
  };

  const sendAgentText = (
    status: number,
    text: string,
    request: {
      method: string;
      path: string;
      query?: Record<string, string>;
      body?: unknown;
      meta?: unknown;
      upload_bytes?: number;
    },
  ) => {
    sendText(res, status, text);
    emitAgentEvent({
      command,
      subcommand,
      request,
      response: status >= 400 ? { status, error: text } : { status, text },
    });
  };

  if (command === "code") {
    if (req.method === "POST" && subcommand === "add") {
      const raw = await readRequestBody(req);
      let body: any = {};
      if (raw && raw.trim().length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          sendAgentText(400, "invalid json", { method: req.method ?? "", path: pathname, body: raw });
          return true;
        }
      }
      const directory = typeof body.directory === "string" ? body.directory.trim() : "";
      const summary = typeof body.summary === "string" ? body.summary.trim() : "";
      if (!directory || !summary) {
        sendAgentText(400, "missing directory or summary", { method: req.method ?? "", path: pathname, body });
        return true;
      }
      const entry = await createCodeRegistryEntry(db, { identityId: ctx.identityId, directory, summary });
      sendAgentJson(
        200,
        { idx: entry.idx, directory: entry.directory, summary: entry.summary },
        { method: req.method ?? "", path: pathname, body },
      );
      return true;
    }
    if (req.method === "GET" && subcommand === "list") {
      const entries = await listCodeRegistryEntries(db, ctx.identityId);
      sendAgentJson(
        200,
        { items: entries.map((row) => ({ idx: row.idx, directory: row.directory, summary: row.summary })) },
        { method: req.method ?? "", path: pathname },
      );
      return true;
    }
    if (req.method === "POST" && subcommand === "ignore") {
      const raw = await readRequestBody(req);
      let body: any = {};
      if (raw && raw.trim().length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          sendAgentText(400, "invalid json", { method: req.method ?? "", path: pathname, body: raw });
          return true;
        }
      }
      const target = typeof body.target === "string" ? body.target.trim() : "";
      if (!target) {
        sendAgentText(400, "missing target", { method: req.method ?? "", path: pathname, body });
        return true;
      }
      const deleted = await ignoreCodeRegistryEntry(db, { identityId: ctx.identityId, target });
      sendAgentJson(200, { deleted }, { method: req.method ?? "", path: pathname, body });
      return true;
    }
  }

  if (command === "site") {
    if (req.method === "POST" && subcommand === "add") {
      const raw = await readRequestBody(req);
      let body: any = {};
      if (raw && raw.trim().length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          sendAgentText(400, "invalid json", { method: req.method ?? "", path: pathname, body: raw });
          return true;
        }
      }
      const port = Number(body.port);
      const summary = typeof body.summary === "string" ? body.summary.trim() : "";
      const sitePath = typeof body.path === "string" ? body.path.trim() : "";
      if (!Number.isFinite(port) || port <= 0) {
        sendAgentText(400, "invalid port", { method: req.method ?? "", path: pathname, body });
        return true;
      }
      if (!summary) {
        sendAgentText(400, "missing summary", { method: req.method ?? "", path: pathname, body });
        return true;
      }
      const entry = await createSiteRegistryEntry(db, { identityId: ctx.identityId, port, path: sitePath, summary });
      sendAgentJson(
        200,
        {
          idx: entry.idx,
          port: entry.port,
          path: entry.path,
          summary: entry.summary,
          url: buildLocalSiteUrl(entry.port, entry.path),
        },
        { method: req.method ?? "", path: pathname, body },
      );
      return true;
    }
    if (req.method === "GET" && subcommand === "list") {
      const entries = await listSiteRegistryEntries(db, ctx.identityId);
      sendAgentJson(
        200,
        {
          items: entries.map((row) => ({
            idx: row.idx,
            port: row.port,
            path: row.path,
            summary: row.summary,
            url: buildLocalSiteUrl(row.port, row.path),
          })),
        },
        { method: req.method ?? "", path: pathname },
      );
      return true;
    }
    if (req.method === "POST" && subcommand === "ignore") {
      const raw = await readRequestBody(req);
      let body: any = {};
      if (raw && raw.trim().length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          sendAgentText(400, "invalid json", { method: req.method ?? "", path: pathname, body: raw });
          return true;
        }
      }
      const idx = Number(body.idx);
      if (!Number.isFinite(idx)) {
        sendAgentText(400, "invalid idx", { method: req.method ?? "", path: pathname, body });
        return true;
      }
      const deleted = await ignoreSiteRegistryEntry(db, { identityId: ctx.identityId, idx });
      sendAgentJson(200, { deleted }, { method: req.method ?? "", path: pathname, body });
      return true;
    }
  }

  if (command === "static-deploy") {
    if (req.method === "GET" && subcommand === "list") {
      const entries = await listStaticDeploys(db, ctx.identityId);
      sendAgentJson(
        200,
        {
          items: entries.map((row) => ({
            idx: row.idx,
            time: row.created_at,
            summary: row.summary,
            app_name: row.app_name,
            url: `http://${row.stable_host}`,
          })),
        },
        { method: req.method ?? "", path: pathname },
      );
      return true;
    }
    if (req.method === "POST" && subcommand === "rollback") {
      const raw = await readRequestBody(req);
      let body: any = {};
      if (raw && raw.trim().length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          sendAgentText(400, "invalid json", { method: req.method ?? "", path: pathname, body: raw });
          return true;
        }
      }
      const idx = Number(body.idx);
      if (!Number.isFinite(idx)) {
        sendAgentText(400, "invalid idx", { method: req.method ?? "", path: pathname, body });
        return true;
      }
      const entry = await getStaticDeployByIdx(db, ctx.identityId, idx);
      if (!entry) {
        sendAgentText(404, "deploy not found", { method: req.method ?? "", path: pathname, body });
        return true;
      }
      const stableHost = entry.stable_host;
      const stableConfPath = path.join(NGINX_CONF_DIR, `site-${entry.session_id}.conf`);
      await writeFile(stableConfPath, buildNginxServerBlock(stableHost, entry.root_path), "utf8");
      const reload = await runCommand("nginx", ["-s", "reload"]);
      if (reload.exitCode !== 0) {
        sendAgentText(500, `nginx reload failed: ${reload.stderr || reload.stdout}`, {
          method: req.method ?? "",
          path: pathname,
          body,
        });
        return true;
      }
      await setStaticDeployActive(db, { identityId: ctx.identityId, sessionId: entry.session_id, idx: entry.idx });
      sendAgentJson(
        200,
        { status: "rolled_back", idx: entry.idx, url: `http://${stableHost}` },
        { method: req.method ?? "", path: pathname, body },
      );
      return true;
    }
    if (req.method === "POST" && subcommand === "new") {
      const meta = parseAgentMeta(readHeader(req, "x-tintin-meta"));
      const summary = typeof meta?.summary === "string" ? meta.summary.trim() : "";
      const appName = typeof meta?.app_name === "string" ? meta.app_name.trim() : "";
      if (!summary || !appName) {
        sendAgentText(400, "missing summary or app_name", { method: req.method ?? "", path: pathname, meta });
        return true;
      }
      const requestInfo: {
        method: string;
        path: string;
        meta?: unknown;
        upload_bytes?: number;
      } = { method: req.method ?? "", path: pathname, meta };
      const tmpArchive = path.join(DYNAMIC_DEPLOY_ROOT, "tmp", `static-${ctx.sessionId}-${Date.now()}.tar.gz`);
      try {
        const uploadBytes = await writeRequestToFile(req, tmpArchive, MAX_UPLOAD_BYTES);
        requestInfo.upload_bytes = uploadBytes;
        const entry = await createStaticDeployEntry(db, {
          identityId: ctx.identityId,
          sessionId: ctx.sessionId,
          appName,
          summary,
          rootPath: "",
          versionHost: "",
          stableHost: `${ctx.sessionId}.site.ctf.so`,
        });
        const rootPath = path.join(STATIC_SITE_ROOT, ctx.sessionId, String(entry.idx));
        const versionHost = `${ctx.sessionId}-${entry.idx}.site.ctf.so`;
        const stableHost = `${ctx.sessionId}.site.ctf.so`;
        const versionConfPath = path.join(NGINX_CONF_DIR, `site-${ctx.sessionId}-${entry.idx}.conf`);
        const stableConfPath = path.join(NGINX_CONF_DIR, `site-${ctx.sessionId}.conf`);
        let prevStableConf: string | null = null;
        try {
          prevStableConf = await readFile(stableConfPath, "utf8");
        } catch {
          prevStableConf = null;
        }
        try {
          await safeExtractTar(tmpArchive, rootPath);
          await writeFile(versionConfPath, buildNginxServerBlock(versionHost, rootPath), "utf8");
          await writeFile(stableConfPath, buildNginxServerBlock(stableHost, rootPath), "utf8");
          const reload = await runCommand("nginx", ["-s", "reload"]);
          if (reload.exitCode !== 0) {
            throw new Error(`nginx reload failed: ${reload.stderr || reload.stdout}`);
          }
          await updateStaticDeployEntry(db, {
            identityId: ctx.identityId,
            idx: entry.idx,
            patch: { root_path: rootPath, version_host: versionHost, stable_host: stableHost, is_active: 1 },
          });
          await setStaticDeployActive(db, { identityId: ctx.identityId, sessionId: ctx.sessionId, idx: entry.idx });
          sendAgentJson(200, { idx: entry.idx, url: `http://${stableHost}` }, requestInfo);
          return true;
        } catch (err) {
          if (prevStableConf !== null) {
            await writeFile(stableConfPath, prevStableConf, "utf8").catch(() => {});
          } else {
            await rm(stableConfPath, { force: true }).catch(() => {});
          }
          await rm(versionConfPath, { force: true }).catch(() => {});
          await rm(rootPath, { recursive: true, force: true }).catch(() => {});
          await db
            .deleteFrom("static_deploys")
            .where("identity_id", "=", ctx.identityId)
            .where("idx", "=", entry.idx)
            .execute()
            .catch(() => {});
          await runCommand("nginx", ["-s", "reload"]).catch(() => {});
          sendAgentText(500, `static deploy failed: ${String(err)}`, requestInfo);
          return true;
        }
      } finally {
        await rm(tmpArchive, { force: true }).catch(() => {});
      }
    }
  }

  if (command === "dynamic-deploy") {
    if (req.method === "GET" && subcommand === "list") {
      const entries = await listDynamicDeploys(db, ctx.identityId);
      sendAgentJson(
        200,
        {
          items: entries.map((row) => ({
            idx: row.idx,
            time: row.created_at,
            summary: row.summary,
            app_name: row.app_name,
          })),
        },
        { method: req.method ?? "", path: pathname },
      );
      return true;
    }
    if (req.method === "GET" && subcommand === "log") {
      const idxRaw = url.searchParams.get("idx") ?? "";
      const idx = Number(idxRaw);
      if (!Number.isFinite(idx)) {
        sendAgentText(400, "invalid idx", {
          method: req.method ?? "",
          path: pathname,
          query: { idx: idxRaw },
        });
        return true;
      }
      const entry = await getDynamicDeployByIdx(db, ctx.identityId, idx);
      if (!entry) {
        sendAgentText(404, "deploy not found", {
          method: req.method ?? "",
          path: pathname,
          query: { idx: idxRaw },
        });
        return true;
      }
      if (!deps.cloudManager || deps.cloudManager.getProviderId() !== "modal") {
        sendAgentText(503, "modal provider required", {
          method: req.method ?? "",
          path: pathname,
          query: { idx: idxRaw },
        });
        return true;
      }
      const modal = deps.cloudManager.getModalProviderForDeploy();
      const sandbox = await modal.getSandboxHandle(entry.workspace_id);
      if (!sandbox) {
        sendAgentText(404, "sandbox not found", {
          method: req.method ?? "",
          path: pathname,
          query: { idx: idxRaw },
        });
        return true;
      }
      const logCmd = `tail -n 400 ${JSON.stringify(entry.log_path)}`;
      const proc = await sandbox.exec(["/bin/sh", "-lc", logCmd], { workdir: "/", timeoutMs: 10_000, mode: "text" });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.readText(), proc.stderr.readText(), proc.wait()]);
      if (exitCode !== 0) {
        sendAgentText(500, stderr || stdout || "log unavailable", {
          method: req.method ?? "",
          path: pathname,
          query: { idx: idxRaw },
        });
        return true;
      }
      sendAgentText(200, stdout || "", {
        method: req.method ?? "",
        path: pathname,
        query: { idx: idxRaw },
      });
      return true;
    }
    if (req.method === "POST" && subcommand === "rollback") {
      const raw = await readRequestBody(req);
      let body: any = {};
      if (raw && raw.trim().length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          sendAgentText(400, "invalid json", { method: req.method ?? "", path: pathname, body: raw });
          return true;
        }
      }
      const idx = Number(body.idx);
      if (!Number.isFinite(idx)) {
        sendAgentText(400, "invalid idx", { method: req.method ?? "", path: pathname, body });
        return true;
      }
      const entry = await getDynamicDeployByIdx(db, ctx.identityId, idx);
      if (!entry) {
        sendAgentText(404, "deploy not found", { method: req.method ?? "", path: pathname, body });
        return true;
      }
      if (!deps.cloudManager || deps.cloudManager.getProviderId() !== "modal") {
        sendAgentText(503, "modal provider required", { method: req.method ?? "", path: pathname, body });
        return true;
      }
      const modal = deps.cloudManager.getModalProviderForDeploy();
      const startup = entry.startup;
      const port = entry.port;
      let setupList: string[] = [];
      try {
        setupList = normalizeSetupList(JSON.parse(entry.setup_json || "[]"));
      } catch {
        setupList = [];
      }
      const archivePath = entry.archive_path;
      const imageRef = entry.image_ref;
      const useSnapshot = Boolean(entry.snapshot_id);
      let workspace = null as any;
      let usedSnapshot = false;
      if (useSnapshot && entry.snapshot_id) {
        try {
          workspace = await modal.createWorkspaceFromSnapshot(entry.snapshot_id, { encryptedPorts: [port] });
          usedSnapshot = true;
        } catch (e) {
          logger.warn(`[deploy][dynamic] snapshot restore failed idx=${entry.idx}: ${String(e)}`);
        }
      }
      if (!workspace) {
        const imageTag = imageRef && !imageRef.startsWith("modal://") ? imageRef : "";
        const imageId = imageRef && imageRef.startsWith("modal://") ? imageRef.slice("modal://".length) : "";
        workspace = await modal.createWorkspaceFromImageRef({
          imageId,
          imageTag,
          label: imageRef || "deploy",
          encryptedPorts: [port],
        });
      }
      const appDir = path.posix.join(workspace.rootPath, "app");
      const logPath = path.posix.join(workspace.rootPath, ".deploy", "startup.log");
      const commands: string[] = [`mkdir -p ${JSON.stringify(appDir)}`];
      if (!usedSnapshot) {
        await modal.uploadFileFromPath(workspace, archivePath, ".deploy/archive.tar.gz");
        const archiveRemote = path.posix.join(workspace.rootPath, ".deploy", "archive.tar.gz");
        commands.push(
          `tar -xzf ${JSON.stringify(archiveRemote)} -C ${JSON.stringify(appDir)}`,
          `rm -f ${JSON.stringify(archiveRemote)}`,
          ...setupList,
        );
      }
      commands.push(
        `cd ${JSON.stringify(appDir)} && nohup /bin/sh -lc ${JSON.stringify(startup)} > ${JSON.stringify(logPath)} 2>&1 &`,
      );
      try {
        await modal.runCommands({ workspace, cwd: "/", commands });
      } catch (e) {
        sendAgentText(500, `deploy rollback failed: ${String(e)}`, { method: req.method ?? "", path: pathname, body });
        return true;
      }
      const sandbox = await modal.getSandboxHandle(workspace.id);
      const urlResult = await resolveModalTunnelUrl(sandbox, port);
      await updateDynamicDeployEntry(db, {
        identityId: ctx.identityId,
        idx: entry.idx,
        patch: { workspace_id: workspace.id, url: urlResult, status: "running", log_path: logPath },
      });
      sendAgentJson(
        200,
        { status: "rolled_back", idx: entry.idx, url: urlResult },
        { method: req.method ?? "", path: pathname, body },
      );
      return true;
    }
    if (req.method === "POST" && subcommand.startsWith("new")) {
      const meta = parseAgentMeta(readHeader(req, "x-tintin-meta"));
      const summary = typeof meta?.summary === "string" ? meta.summary.trim() : "";
      const appName = typeof meta?.app_name === "string" ? meta.app_name.trim() : "";
      const startup = typeof meta?.startup === "string" ? meta.startup.trim() : "";
      const setupList = normalizeSetupList(meta?.setup);
      const ignoreList = normalizeIgnoreList(meta?.ignore);
      const metaPort = Number(meta?.port);
      const overridePort = Number.isFinite(metaPort) ? metaPort : null;
      if (!summary || !appName || !startup) {
        sendAgentText(400, "missing summary, app_name, or startup", { method: req.method ?? "", path: pathname, meta });
        return true;
      }
      if (!deps.cloudManager || deps.cloudManager.getProviderId() !== "modal") {
        sendAgentText(503, "modal provider required", { method: req.method ?? "", path: pathname, meta });
        return true;
      }
      const requestInfo: {
        method: string;
        path: string;
        meta?: unknown;
        upload_bytes?: number;
      } = { method: req.method ?? "", path: pathname, meta };
      const tmpArchive = path.join(DYNAMIC_DEPLOY_ROOT, "tmp", `dynamic-${ctx.sessionId}-${Date.now()}.tar.gz`);
      try {
        const uploadBytes = await writeRequestToFile(req, tmpArchive, MAX_UPLOAD_BYTES);
        requestInfo.upload_bytes = uploadBytes;
        const modalCfg = config.cloud?.modal;
        const imageForKind = () => {
          if (!modalCfg) return { imageTag: "", imageId: "" };
          if (subcommand === "new-next" && modalCfg.image_next) return { imageTag: modalCfg.image_next, imageId: "" };
          if (subcommand === "new-express" && modalCfg.image_express) return { imageTag: modalCfg.image_express, imageId: "" };
          if (subcommand === "new-flask" && modalCfg.image_flask) return { imageTag: modalCfg.image_flask, imageId: "" };
          if (modalCfg.image_id) return { imageTag: "", imageId: modalCfg.image_id };
          return { imageTag: modalCfg.image, imageId: "" };
        };
        const { imageTag, imageId } = imageForKind();
        const imageRef = imageId ? `modal://${imageId}` : imageTag;
        const port = overridePort ?? inferPortFromStartup(startup);
        const modal = deps.cloudManager.getModalProviderForDeploy();
        const workspace = await modal.createWorkspaceFromImageRef({
          imageId,
          imageTag,
          label: imageRef || "deploy",
          encryptedPorts: [port],
        });
        await modal.uploadFileFromPath(workspace, tmpArchive, ".deploy/archive.tar.gz");
        const appDir = path.posix.join(workspace.rootPath, "app");
        const archiveRemote = path.posix.join(workspace.rootPath, ".deploy", "archive.tar.gz");
        const logPath = path.posix.join(workspace.rootPath, ".deploy", "startup.log");
        const commands: string[] = [
          `mkdir -p ${JSON.stringify(appDir)}`,
          `tar -xzf ${JSON.stringify(archiveRemote)} -C ${JSON.stringify(appDir)}`,
          `rm -f ${JSON.stringify(archiveRemote)}`,
          ...setupList,
          `cd ${JSON.stringify(appDir)} && nohup /bin/sh -lc ${JSON.stringify(startup)} > ${JSON.stringify(logPath)} 2>&1 &`,
        ];
        await modal.runCommands({ workspace, cwd: "/", commands });
        const sandbox = await modal.getSandboxHandle(workspace.id);
        const urlResult = await resolveModalTunnelUrl(sandbox, port);
        const entry = await createDynamicDeployEntry(db, {
          identityId: ctx.identityId,
          sessionId: ctx.sessionId,
          appName,
          summary,
          provider: "modal",
          imageRef,
          workspaceId: workspace.id,
          port,
          startup,
          setupJson: JSON.stringify(setupList),
          ignoreJson: JSON.stringify(ignoreList),
          archivePath: tmpArchive,
          logPath,
        });
        const archiveDir = path.join(DYNAMIC_DEPLOY_ROOT, "archives", ctx.sessionId);
        const archivePath = path.join(archiveDir, `${entry.idx}.tar.gz`);
        await mkdir(archiveDir, { recursive: true });
        await rename(tmpArchive, archivePath);
        let snapshotId: string | null = null;
        try {
          snapshotId = await modal.snapshotWorkspace(workspace, "deploy");
        } catch (e) {
          logger.warn(`[deploy][dynamic] snapshot failed idx=${entry.idx}: ${String(e)}`);
        }
        await updateDynamicDeployEntry(db, {
          identityId: ctx.identityId,
          idx: entry.idx,
          patch: {
            archive_path: archivePath,
            url: urlResult,
            status: "running",
            snapshot_id: snapshotId,
          },
        });
        sendAgentJson(200, { idx: entry.idx, log: entry.log_path, url: urlResult }, requestInfo);
        return true;
      } finally {
        await rm(tmpArchive, { force: true }).catch(() => {});
      }
    }
  }

  sendText(res, 404, "not found");
  return true;
}
