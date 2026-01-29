import type http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db.js";
import type { Logger } from "../../log.js";
import { sleep } from "../../util.js";
import type { UserLanguage } from "../../../locales/index.js";
import { getAgentAdapter } from "../../agents.js";
import { mapEventToFragments } from "../../streamer.js";
import {
  deleteSecret,
  getCloudRun,
  getSecret,
  listCloudRunScreenshots,
  listCloudRunsForIdentity,
  listSecrets,
  setSecret,
} from "../../cloud/store.js";
import { buildRunArtifactsFromJsonl } from "../../cloud/uiArtifacts.js";
import { verifyUiToken, type UiTokenPayload } from "../../cloud/uiTokens.js";
import { encryptSecret } from "../../cloud/secrets.js";
import { signScreenshotUrl } from "../../cloud/s3.js";
import { listJsonlFiles, readNewJsonlLines } from "../fileOps.js";
import {
  readHeader,
  readRequestBody,
  sendJson,
  sendSse,
  sendText,
} from "../httpUtils.js";

type CloudApiDeps = {
  config: AppConfig;
  db: Db;
  logger: Logger;
  resolveSessionLanguage: (session: { language?: string | null }) => UserLanguage;
};

const extractUiToken = (req: http.IncomingMessage, url: URL): string | null => {
  const header = readHeader(req, "authorization");
  if (header && header.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  const fromQuery = url.searchParams.get("token");
  return fromQuery && fromQuery.length > 0 ? fromQuery : null;
};

const requireUiAuth = (
  deps: CloudApiDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): UiTokenPayload | null => {
  const uiConfig = deps.config.cloud?.ui ?? null;
  if (!uiConfig || !uiConfig.token_secret) {
    sendText(res, 503, "UI auth not configured");
    return null;
  }
  const token = extractUiToken(req, url);
  if (!token) {
    sendText(res, 401, "missing token");
    return null;
  }
  const payload = verifyUiToken(uiConfig, token);
  if (!payload) {
    sendText(res, 401, "invalid token");
    return null;
  }
  return payload;
};

const requireRunAccess = async (
  deps: CloudApiDeps,
  payload: UiTokenPayload,
  runId: string,
  res: http.ServerResponse,
): Promise<Awaited<ReturnType<typeof getCloudRun>> | null> => {
  const run = await getCloudRun(deps.db, runId);
  if (!run) {
    sendText(res, 404, "run not found");
    return null;
  }
  if (payload.scope === "run" && payload.run_id !== runId) {
    sendText(res, 403, "forbidden");
    return null;
  }
  if (payload.scope === "identity" && payload.identity_id !== run.identity_id) {
    sendText(res, 403, "forbidden");
    return null;
  }
  return run;
};

const resolveRunLogFiles = async (
  deps: CloudApiDeps,
  sessionId: string,
  session: { agent: string; codex_cwd: string; codex_session_id: string | null },
): Promise<string[]> => {
  if (deps.config.cloud?.workspaces_dir) {
    const logsDir = path.join(deps.config.cloud.workspaces_dir, "logs", sessionId);
    const fromLogs = await listJsonlFiles(logsDir);
    if (fromLogs.length > 0) return fromLogs;
  }
  if (!session.codex_session_id) return [];
  const adapter = getAgentAdapter(session.agent as any);
  const sessionsRoot = adapter.resolveSessionsRoot(session.codex_cwd, deps.config);
  const homeDir = adapter.resolveHomeDir(sessionsRoot);
  return await adapter.findSessionJsonlFiles({
    sessionsRoot,
    homeDir,
    cwd: session.codex_cwd,
    sessionId: session.codex_session_id,
    timeoutMs: 2_000,
    pollMs: 200,
  });
};

export async function handleCloudApiRoutes(params: {
  deps: CloudApiDeps;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  pathname: string;
  pathParts: string[];
}): Promise<boolean> {
  const { deps, req, res, url, pathname, pathParts } = params;
  const { config, db, logger } = deps;
  const uiConfig = config.cloud?.ui ?? null;

  if (pathParts[0] !== "api" || pathParts[1] !== "cloud") return false;

  const payload = requireUiAuth(deps, req, res, url);
  if (!payload) return true;

  if (pathParts[2] === "secrets") {
    if (payload.scope !== "identity") {
      sendText(res, 403, "identity token required");
      return true;
    }
    if (!config.cloud?.secrets_key) {
      sendText(res, 503, "secrets not configured");
      return true;
    }
    if (req.method === "GET" && pathParts.length === 3) {
      const secrets = await listSecrets(db, payload.identity_id);
      sendJson(res, 200, { secrets });
      return true;
    }
    if (req.method === "POST" && pathParts.length === 3) {
      const rawBody = await readRequestBody(req);
      let parsed: any = {};
      if (rawBody && rawBody.trim().length > 0) {
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          sendText(res, 400, "invalid json");
          return true;
        }
      }
      const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
      const valueRaw = typeof parsed.value === "string" ? parsed.value : "";
      const value = valueRaw.trim();
      const modeRaw = typeof parsed.mode === "string" ? parsed.mode.toLowerCase() : "set";
      if (!name) {
        sendText(res, 400, "missing name");
        return true;
      }
      if (!value) {
        sendText(res, 400, "missing value");
        return true;
      }
      if (!["set", "create", "update"].includes(modeRaw)) {
        sendText(res, 400, "invalid mode");
        return true;
      }
      const existing = await getSecret(db, payload.identity_id, name);
      if (modeRaw === "create" && existing) {
        sendText(res, 409, "secret already exists");
        return true;
      }
      if (modeRaw === "update" && !existing) {
        sendText(res, 404, "secret not found");
        return true;
      }
      const encrypted = encryptSecret(value, config.cloud.secrets_key);
      await setSecret(db, { identityId: payload.identity_id, name, encryptedValue: encrypted });
      sendJson(res, existing ? 200 : 201, { status: existing ? "updated" : "created" });
      return true;
    }
    if (req.method === "DELETE" && pathParts.length === 4) {
      let name = pathParts[3] ?? "";
      try {
        name = decodeURIComponent(name);
      } catch {
        // keep raw
      }
      if (!name) {
        sendText(res, 400, "missing name");
        return true;
      }
      const deleted = await deleteSecret(db, payload.identity_id, name);
      sendJson(res, 200, { deleted });
      return true;
    }
  }

  if (req.method === "GET" && pathParts[2] === "runs" && pathParts.length === 3) {
    if (payload.scope === "run") {
      const run = await getCloudRun(db, payload.run_id);
      if (!run) {
        sendJson(res, 200, { runs: [], nextCursor: null });
        return true;
      }
      sendJson(res, 200, { runs: [run], nextCursor: null });
      return true;
    }
    const limitRaw = url.searchParams.get("limit");
    const cursorRaw = url.searchParams.get("cursor");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const before = cursorRaw ? Number(cursorRaw) : undefined;
    const runs = await listCloudRunsForIdentity(db, {
      identityId: payload.identity_id,
      limit: Number.isFinite(limit) ? limit : undefined,
      before: Number.isFinite(before) ? before : undefined,
    });
    const nextCursor = runs.length > 0 ? runs[runs.length - 1]!.created_at : null;
    sendJson(res, 200, { runs, nextCursor });
    return true;
  }

  if (req.method === "GET" && pathParts[2] === "runs" && pathParts.length >= 4) {
    const runId = pathParts[3] ?? "";
    if (!runId) {
      sendText(res, 400, "missing run id");
      return true;
    }

    if (pathParts[4] === "events") {
      const run = await requireRunAccess(deps, payload, runId, res);
      if (!run) return true;
      if (!run.session_id) {
        sendText(res, 404, "run has no session");
        return true;
      }
      const session = await db.selectFrom("sessions").selectAll().where("id", "=", run.session_id).executeTakeFirst();
      if (!session) {
        sendText(res, 404, "session not found");
        return true;
      }
      const once = url.searchParams.get("once") === "1";
      const pollRaw = url.searchParams.get("poll");
      const pollParsed = pollRaw ? Number(pollRaw) : NaN;
      const pollMs =
        Number.isFinite(pollParsed) && pollParsed > 0
          ? Math.max(50, Math.min(Math.floor(pollParsed), 2000))
          : 500;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.flushHeaders();
      sendSse(res, { ok: true }, "ready");

      let closed = false;
      req.on("close", () => {
        closed = true;
      });

      const offsets = new Map<string, number>();
      while (!closed) {
        let hadNew = false;
        const files = await resolveRunLogFiles(deps, run.session_id, session);
        const lang = deps.resolveSessionLanguage(session);
        for (const file of files) {
          const prevOffset = offsets.get(file) ?? 0;
          const { lines, newOffset } = await readNewJsonlLines(file, prevOffset);
          if (lines.length === 0) {
            offsets.set(file, newOffset);
            continue;
          }
          offsets.set(file, newOffset);
          hadNew = true;
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let obj: unknown;
            try {
              obj = JSON.parse(trimmed);
            } catch {
              continue;
            }
            const fragments = mapEventToFragments(session.agent, obj, {
              includeUserMessages: true,
              verbosity: 3,
              lang,
            });
            for (const frag of fragments) {
              if (frag.kind === "final") continue;
              if (frag.kind === "plan_update") {
                sendSse(res, { kind: "plan_update", plan: frag.plan, explanation: frag.explanation });
                continue;
              }
              sendSse(res, frag);
            }
          }
        }
        if (once && !hadNew) {
          const current = await db
            .selectFrom("sessions")
            .select(["status"])
            .where("id", "=", run.session_id)
            .executeTakeFirst();
          if (!current || (current.status !== "running" && current.status !== "starting")) break;
        }
        await sleep(pollMs);
      }
      res.end();
      return true;
    }

    if (pathParts[4] === "artifacts") {
      const run = await requireRunAccess(deps, payload, runId, res);
      if (!run) return true;
      if (!run.session_id) {
        sendJson(res, 200, { diffs: [], commands: [] });
        return true;
      }
      const session = await db.selectFrom("sessions").selectAll().where("id", "=", run.session_id).executeTakeFirst();
      if (!session) {
        sendJson(res, 200, { diffs: [], commands: [] });
        return true;
      }
      const files = await resolveRunLogFiles(deps, run.session_id, session);
      let baselineResolver: ((filePath: string) => Promise<string | null>) | undefined;
      if (config.cloud?.provider === "local" && config.cloud?.workspaces_dir) {
        let root: string | null = null;
        if (run.snapshot_id) {
          root = path.join(config.cloud.workspaces_dir, "snapshots", run.snapshot_id);
        } else if (run.workspace_id) {
          root = path.join(config.cloud.workspaces_dir, run.workspace_id);
        }
        if (root) {
          const mount = run.primary_repo_id
            ? await db
                .selectFrom("cloud_run_repos")
                .select(["mount_path"])
                .where("run_id", "=", run.id)
                .where("repo_id", "=", run.primary_repo_id)
                .executeTakeFirst()
            : null;
          const repoRoot = mount ? path.join(root, mount.mount_path) : root;
          baselineResolver = async (filePath: string) => {
            const full = path.join(repoRoot, filePath);
            if (!full.startsWith(repoRoot)) return null;
            return await readFile(full, "utf8").catch(() => null);
          };
        }
      }
      const artifacts = await buildRunArtifactsFromJsonl(files, session.agent, {
        baselineResolver,
        fallbackPatch: run.diff_patch ?? null,
        fallbackTimestamp: run.finished_at ?? null,
      });
      sendJson(res, 200, artifacts);
      return true;
    }

    if (pathParts.length === 4) {
      const run = await requireRunAccess(deps, payload, runId, res);
      if (!run) return true;
      const identity = await db.selectFrom("identities").selectAll().where("id", "=", run.identity_id).executeTakeFirst();
      const repos = await db
        .selectFrom("cloud_run_repos")
        .innerJoin("repos", "repos.id", "cloud_run_repos.repo_id")
        .select(["repos.id", "repos.name", "repos.url", "repos.default_branch", "cloud_run_repos.mount_path"])
        .where("cloud_run_repos.run_id", "=", run.id)
        .execute();
      const session = run.session_id
        ? await db.selectFrom("sessions").selectAll().where("id", "=", run.session_id).executeTakeFirst()
        : null;
      sendJson(res, 200, { run, identity, repos, session });
      return true;
    }
  }

  if (req.method === "GET" && pathParts[2] === "screenshots") {
    const runId = url.searchParams.get("runId") ?? "";
    if (!runId) {
      sendText(res, 400, "missing runId");
      return true;
    }
    const run = await requireRunAccess(deps, payload, runId, res);
    if (!run) return true;
    if (!uiConfig || !uiConfig.s3_bucket || !uiConfig.s3_region) {
      sendText(res, 503, "S3 not configured");
      return true;
    }
    const rows = await listCloudRunScreenshots(db, runId);
    const items = [];
    for (const row of rows) {
      try {
        const url = await signScreenshotUrl(uiConfig, row.s3_key);
        items.push({
          id: row.id,
          url,
          tool: row.tool,
          mime_type: row.mime_type,
          created_at: row.created_at,
        });
      } catch (e) {
        logger.warn(`sign screenshot failed id=${row.id}: ${String(e)}`);
      }
    }
    sendJson(res, 200, { screenshots: items });
    return true;
  }

  sendText(res, 404, "not found");
  return true;
}
