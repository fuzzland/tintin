#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG_PATH="${ROOT_DIR}/config.e2e.toml"
DAEMON_LOG="/tmp/tintin-e2e-daemon.log"
SITE_LOG="/tmp/tintin-e2e-site.log"
DAEMON_PID=""
SITE_PID=""
NODE_BIN="$(command -v node)"
SESSION_ID=""

cleanup_modal_resources() {
  if [ ! -f "${ROOT_DIR}/dist/src/runtime/cloud/modalProvider.js" ]; then
    return
  fi
  if [ -z "${SESSION_ID}" ]; then
    return
  fi
  set +e
  "${NODE_BIN}" --input-type=module -e '
    import { loadConfig } from "./dist/src/runtime/config.js";
    import { createLogger } from "./dist/src/runtime/log.js";
    import { ModalCloudProvider } from "./dist/src/runtime/cloud/modalProvider.js";
    import Database from "better-sqlite3";

    const configPath = process.argv[1];
    const sessionId = process.argv[2];
    const config = await loadConfig(configPath);
    if (!config.cloud?.modal) process.exit(0);
    const dbUrl = config.db?.url || "";
    const prefix = "sqlite+aiosqlite:///";
    if (!dbUrl.startsWith(prefix)) process.exit(0);
    const dbPath = dbUrl.slice(prefix.length);
    const db = new Database(dbPath);
    const rows = db
      .prepare("select distinct workspace_id, snapshot_id from dynamic_deploys where workspace_id is not null and session_id = ?")
      .all(sessionId);
    db.close();

    const logger = createLogger(config.bot.log_level);
    const provider = new ModalCloudProvider(config.cloud.modal, logger);

    const workspaces = new Set();
    const snapshots = new Set();
    for (const row of rows) {
      if (row.workspace_id) workspaces.add(row.workspace_id);
      if (row.snapshot_id) snapshots.add(row.snapshot_id);
    }

    for (const id of workspaces) {
      try {
        console.log(`[e2e] terminating sandbox ${id}`);
        await provider.terminateWorkspace({ id, rootPath: config.cloud.modal.workspace_root });
      } catch (err) {
        console.error(`[e2e] terminate failed ${id}: ${err}`);
      }
    }
    if (typeof provider.deleteSnapshotImage === "function") {
      for (const snapshotId of snapshots) {
        try {
          console.log(`[e2e] deleting snapshot ${snapshotId}`);
          await provider.deleteSnapshotImage(snapshotId);
        } catch (err) {
          console.error(`[e2e] delete snapshot failed ${snapshotId}: ${err}`);
        }
      }
    }
  ' "${CONFIG_PATH}" "${SESSION_ID}" >/dev/null 2>&1
  set -e
}

cleanup() {
  if [ -n "${SITE_PID}" ]; then
    kill "${SITE_PID}" >/dev/null 2>&1 || true
  fi
  if [ -n "${DAEMON_PID}" ]; then
    kill "${DAEMON_PID}" >/dev/null 2>&1 || true
  fi
  cleanup_modal_resources
}
trap cleanup EXIT

if [ ! -f "${CONFIG_PATH}" ]; then
  echo "[e2e] missing ${CONFIG_PATH}; create it by copying config.toml first" >&2
  exit 1
fi

if command -v sudo >/dev/null 2>&1; then
  echo "[e2e] preparing local deploy dirs"
  sudo mkdir -p /mnt/data/deploys/dynamic /mnt/data/sites
  sudo chmod 777 /mnt/data/deploys /mnt/data/deploys/dynamic /mnt/data/sites
  sudo chmod 777 /etc/nginx/conf.d
  echo "[e2e] tuning nginx server_names_hash_bucket_size"
  echo "server_names_hash_bucket_size 128;" | sudo tee /etc/nginx/conf.d/tintin-e2e.conf >/dev/null
  sudo nginx -s reload >/dev/null 2>&1 || true
fi

BOT_HOST=$(awk '
  $0 ~ /^\[bot\]/ { inSection=1; next }
  /^\[/ { inSection=0 }
  inSection && $1 == "host" { gsub(/"/, "", $3); print $3; exit }
' "${CONFIG_PATH}")
BOT_PORT=$(awk '
  $0 ~ /^\[bot\]/ { inSection=1; next }
  /^\[/ { inSection=0 }
  inSection && $1 == "port" { gsub(/"/, "", $3); print $3; exit }
' "${CONFIG_PATH}")

if [ -z "${BOT_HOST}" ] || [ "${BOT_HOST}" = "0.0.0.0" ]; then
  BOT_HOST="127.0.0.1"
fi
BOT_PORT="${BOT_PORT:-8787}"
HELPER_MOUNT="-v ${ROOT_DIR}:${ROOT_DIR}:ro"
HELPER_USER="--user 0:0"

echo "[e2e] building tintin"
(cd "${ROOT_DIR}" && npm run build)

echo "[e2e] running migrations"
(cd "${ROOT_DIR}" && CONFIG_PATH="${CONFIG_PATH}" npm run migrate)

echo "[e2e] starting tintin daemon"
if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  sudo -n env TINTIN_E2E=1 CONFIG_PATH="${CONFIG_PATH}" "${NODE_BIN}" "${ROOT_DIR}/dist/src/main.js" >"${DAEMON_LOG}" 2>&1 &
  DAEMON_PID=$!
else
  TINTIN_E2E=1 CONFIG_PATH="${CONFIG_PATH}" "${NODE_BIN}" "${ROOT_DIR}/dist/src/main.js" >"${DAEMON_LOG}" 2>&1 &
  DAEMON_PID=$!
fi

echo "[e2e] waiting for daemon"
for i in $(seq 1 30); do
  if curl -fsS "http://${BOT_HOST}:${BOT_PORT}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "http://${BOT_HOST}:${BOT_PORT}/healthz" >/dev/null 2>&1; then
  echo "[e2e] daemon failed to start; see ${DAEMON_LOG}" >&2
  exit 1
fi

echo "[e2e] requesting agent token"
TOKEN_JSON=$(curl -fsS -X POST "http://${BOT_HOST}:${BOT_PORT}/api/cloud/agent/e2e-token" -H "content-type: application/json" -d '{}')
SESSION_ID=$(node -e 'const data=JSON.parse(process.argv[1]); console.log(data.sessionId);' "${TOKEN_JSON}")
AGENT_TOKEN=$(node -e 'const data=JSON.parse(process.argv[1]); console.log(data.token);' "${TOKEN_JSON}")

if [ -z "${SESSION_ID}" ] || [ -z "${AGENT_TOKEN}" ]; then
  echo "[e2e] failed to fetch session/token" >&2
  exit 1
fi

echo "[e2e] building helper image"
docker build -t tintin-e2e -f "${ROOT_DIR}/image/Dockerfile" "${ROOT_DIR}/image"

echo "[e2e] starting site server on 5173"
(cd "${ROOT_DIR}/tests/fixtures/static-site" && python3 -m http.server 5173 --bind 0.0.0.0 >"${SITE_LOG}" 2>&1) &
SITE_PID=$!
sleep 1

echo "[e2e] site add 5173"
SITE_OUT=$(docker run --rm --network host \
  ${HELPER_USER} ${HELPER_MOUNT} \
  -e TINTIN_AGENT_URL="http://${BOT_HOST}:${BOT_PORT}/api/cloud/agent" \
  -e TINTIN_AGENT_TOKEN="${AGENT_TOKEN}" \
  -e TINTIN_AGENT_SESSION="${SESSION_ID}" \
  -e TINTIN_AGENT_AGENT="codex" \
  tintin-e2e site add 5173 "e2e site")
echo "[e2e] site add output: ${SITE_OUT}"
SITE_URL=$(node -e '
const out = process.argv[1];
const match = out.match(/\((.*)\)/);
if (!match) process.exit(1);
const parts = match[1].split(",").map(s => s.trim());
const url = parts.length >= 5 ? parts[4] : `http://127.0.0.1:${parts[1]}`;
console.log(url);
' "${SITE_OUT}")
curl -fsS "${SITE_URL}" >/dev/null

echo "[e2e] static deploy"
STATIC_OUT=$(docker run --rm --network host \
  ${HELPER_USER} ${HELPER_MOUNT} \
  -e TINTIN_AGENT_URL="http://${BOT_HOST}:${BOT_PORT}/api/cloud/agent" \
  -e TINTIN_AGENT_TOKEN="${AGENT_TOKEN}" \
  -e TINTIN_AGENT_SESSION="${SESSION_ID}" \
  -e TINTIN_AGENT_AGENT="codex" \
  tintin-e2e static-deploy new "${ROOT_DIR}/tests/fixtures/static-site" "e2e static" "e2e-static")
echo "[e2e] static deploy output: ${STATIC_OUT}"
STATIC_IDX=$(node -e 'const out=process.argv[1]; const m=out.match(/\((.*)\)/); if (!m) process.exit(1); console.log(m[1].split(",")[0].trim());' "${STATIC_OUT}")
if command -v nginx >/dev/null 2>&1; then
  curl -fsS -H "Host: ${SESSION_ID}.site.ctf.so" "http://127.0.0.1" | rg -q "e2e-static"
else
  echo "[e2e] nginx not found; skipping static host verification" >&2
fi

echo "[e2e] dynamic deploy (express image)"
set +e
DYNAMIC_OUT=$(docker run --rm --network host \
  ${HELPER_USER} ${HELPER_MOUNT} \
  -e TINTIN_AGENT_URL="http://${BOT_HOST}:${BOT_PORT}/api/cloud/agent" \
  -e TINTIN_AGENT_TOKEN="${AGENT_TOKEN}" \
  -e TINTIN_AGENT_SESSION="${SESSION_ID}" \
  -e TINTIN_AGENT_AGENT="codex" \
  tintin-e2e dynamic-deploy new-express "${ROOT_DIR}/tests/fixtures/express-app" "e2e dynamic" "e2e-app" \
  --startup "PORT=3000 node server.js" --port 3000)
DYNAMIC_RC=$?
set -e
if [ "${DYNAMIC_RC}" -ne 0 ]; then
  if rg -q "RESOURCE_EXHAUSTED|spend limit" "${DAEMON_LOG}"; then
    echo "[e2e] modal unavailable (spend limit); skipping dynamic deploy checks" >&2
    echo "[e2e] success (dynamic deploy skipped)"
    exit 0
  fi
  echo "[e2e] dynamic deploy failed; see ${DAEMON_LOG}" >&2
  exit 1
fi
echo "[e2e] dynamic deploy output: ${DYNAMIC_OUT}"
DYNAMIC_URL=$(node -e 'const out=process.argv[1]; const m=out.match(/\((.*)\)/); if (!m) process.exit(1); const parts=m[1].split(",").map(s=>s.trim()); console.log(parts[parts.length-1]);' "${DYNAMIC_OUT}")
curl -fsS "${DYNAMIC_URL}" | rg -q "e2e-app"

echo "[e2e] dynamic deploy log"
DYNAMIC_IDX=$(node -e 'const out=process.argv[1]; const m=out.match(/\((.*)\)/); if (!m) process.exit(1); console.log(m[1].split(",")[0].trim());' "${DYNAMIC_OUT}")
docker run --rm --network host \
  ${HELPER_USER} ${HELPER_MOUNT} \
  -e TINTIN_AGENT_URL="http://${BOT_HOST}:${BOT_PORT}/api/cloud/agent" \
  -e TINTIN_AGENT_TOKEN="${AGENT_TOKEN}" \
  -e TINTIN_AGENT_SESSION="${SESSION_ID}" \
  -e TINTIN_AGENT_AGENT="codex" \
  tintin-e2e dynamic-deploy log "${DYNAMIC_IDX}" >/dev/null

echo "[e2e] dynamic deploy rollback"
docker run --rm --network host \
  ${HELPER_USER} ${HELPER_MOUNT} \
  -e TINTIN_AGENT_URL="http://${BOT_HOST}:${BOT_PORT}/api/cloud/agent" \
  -e TINTIN_AGENT_TOKEN="${AGENT_TOKEN}" \
  -e TINTIN_AGENT_SESSION="${SESSION_ID}" \
  -e TINTIN_AGENT_AGENT="codex" \
  tintin-e2e dynamic-deploy rollback "${DYNAMIC_IDX}" >/dev/null

echo "[e2e] verifying snapshot presence in db"
DB_PATH=$(node -e 'const toml=require("@iarna/toml"); const fs=require("fs"); const cfg=toml.parse(fs.readFileSync(process.argv[1],"utf8")); const url=cfg.db?.url || ""; const prefix="sqlite+aiosqlite:///"; if (!url.startsWith(prefix)) process.exit(1); console.log(url.slice(prefix.length));' "${CONFIG_PATH}")
if [ -n "${DB_PATH}" ]; then
  sqlite3 "${ROOT_DIR}/${DB_PATH}" "select snapshot_id from dynamic_deploys where idx=${DYNAMIC_IDX};" | rg -q "."
fi

echo "[e2e] success"
