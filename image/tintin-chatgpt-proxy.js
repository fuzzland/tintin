#!/usr/bin/env node

/**
 * Tintin ChatGPT Codex Proxy
 *
 * Handles request transformation, model normalization, Codex instructions fetching,
 * and token refresh for the ChatGPT Codex backend API.
 *
 * Features:
 * - Model normalization (gpt-5.1-codex-low → gpt-5.1-codex)
 * - Input filtering (remove item_reference, strip IDs for stateless mode)
 * - Codex instructions fetching from GitHub with ETag caching
 * - Reasoning configuration per model type
 * - Proactive token refresh (before each request)
 * - SSE stream passthrough
 * - 404 usage limit → 429 mapping for retryable errors
 */

const fs = require("node:fs");
const http = require("node:http");

// ============================================================================
// CONSTANTS
// ============================================================================

const LOG_PREFIX = process.env.CHATGPT_PROXY_LOG_PREFIX || "[chatgpt][proxy]";
const REFRESH_PREFIX = process.env.CHATGPT_REFRESH_PREFIX || "[chatgpt][refresh]";
const PORT = Number(process.env.CHATGPT_PROXY_PORT || "19191");
const HOST = process.env.CHATGPT_PROXY_HOST || "127.0.0.1";
const UPSTREAM_BASE = "https://chatgpt.com/backend-api";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TIMEOUT_MS = Number(process.env.CHATGPT_PROXY_TIMEOUT_MS || "60000");
const REFRESH_OUT = process.env.CHATGPT_REFRESH_OUT || "";

// GitHub URLs for Codex instructions
const GITHUB_API = "https://api.github.com/repos/openai/codex/releases/latest";
const GITHUB_RAW = "https://raw.githubusercontent.com/openai/codex";

// Environment variables for auth
const ACCESS_TOKEN = process.env.CHATGPT_ACCESS_TOKEN || "";
const REFRESH_TOKEN = process.env.CHATGPT_REFRESH_TOKEN || "";
const EXPIRES_AT = Number(process.env.CHATGPT_EXPIRES_AT || "0");
const ACCOUNT_ID = process.env.CHATGPT_ACCOUNT_ID || "";

// Mutable auth state
let accessToken = ACCESS_TOKEN;
let refreshToken = REFRESH_TOKEN;
let expiresAt = EXPIRES_AT;

// ============================================================================
// MODEL MAPING
// ============================================================================

/**
 * Explicit model name mappings for Codex API.
 * Keys are config model IDs, values are actual API model names.
 */
const MODEL_MAP = {
  // GPT-5.2 Codex (newest)
  "gpt-5.2-codex": "gpt-5.2-codex",
  "gpt-5.2-codex-low": "gpt-5.2-codex",
  "gpt-5.2-codex-medium": "gpt-5.2-codex",
  "gpt-5.2-codex-high": "gpt-5.2-codex",
  "gpt-5.2-codex-xhigh": "gpt-5.2-codex",
  "gpt 5.2 codex": "gpt-5.2-codex",
  "gpt 5.2 codex low": "gpt-5.2-codex",
  "gpt 5.2 codex (chatgpt subscription)": "gpt-5.2-codex",

  // GPT-5.2 (general purpose)
  "gpt-5.2": "gpt-5.2",
  "gpt-5.2-low": "gpt-5.2",
  "gpt-5.2-medium": "gpt-5.2",
  "gpt-5.2-high": "gpt-5.2",
  "gpt-5.2-xhigh": "gpt-5.2",
  "gpt 5.2": "gpt-5.2",
  "gpt 5.2 (chatgpt subscription)": "gpt-5.2",

  // GPT-5.1 Codex Max
  "gpt-5.1-codex-max": "gpt-5.1-codex-max",
  "gpt-5.1-codex-max-low": "gpt-5.1-codex-max",
  "gpt-5.1-codex-max-medium": "gpt-5.1-codex-max",
  "gpt-5.1-codex-max-high": "gpt-5.1-codex-max",
  "gpt-5.1-codex-max-xhigh": "gpt-5.1-codex-max",
  "gpt 5.1 codex max": "gpt-5.1-codex-max",
  "gpt 5.1 codex max (chatgpt subscription)": "gpt-5.1-codex-max",

  // GPT-5.1 Codex Mini
  "gpt-5.1-codex-mini": "gpt-5.1-codex-mini",
  "gpt-5.1-codex-mini-low": "gpt-5.1-codex-mini",
  "gpt-5.1-codex-mini-medium": "gpt-5.1-codex-mini",
  "gpt-5.1-codex-mini-high": "gpt-5.1-codex-mini",
  "gpt 5.1 codex mini": "gpt-5.1-codex-mini",
  "gpt 5.1 codex mini (chatgpt subscription)": "gpt-5.1-codex-mini",

  // Legacy Codex Mini
  "codex-mini-latest": "codex-mini-latest",
  "codex-mini": "codex-mini-latest",
  "gpt-5-codex-mini": "codex-mini-latest",
  "gpt-5-codex-mini-low": "codex-mini-latest",
  "gpt-5-codex-mini-medium": "codex-mini-latest",
  "gpt-5-codex-mini-high": "codex-mini-latest",
  "gpt 5 codex mini": "codex-mini-latest",
  "gpt 5 codex mini (chatgpt subscription)": "codex-mini-latest",
  "gpt 5 codex mini low": "codex-mini-latest",
  "gpt 5 codex mini low (chatgpt subscription)": "codex-mini-latest",

  // GPT-5.1 Codex (standard)
  "gpt-5.1-codex": "gpt-5.1-codex",
  "gpt-5.1-codex-low": "gpt-5.1-codex",
  "gpt-5.1-codex-medium": "gpt-5.1-codex",
  "gpt-5.1-codex-high": "gpt-5.1-codex",
  "gpt 5.1 codex": "gpt-5.1-codex",
  "gpt 5.1 codex low": "gpt-5.1-codex",
  "gpt 5.1 codex (chatgpt subscription)": "gpt-5.1-codex",
  "gpt 5.1 codex low (chatgpt subscription)": "gpt-5.1-codex",

  // GPT-5.1 (general purpose)
  "gpt-5.1": "gpt-5.1",
  "gpt-5.1-low": "gpt-5.1",
  "gpt-5.1-medium": "gpt-5.1",
  "gpt-5.1-high": "gpt-5.1",
  "gpt 5.1": "gpt-5.1",
  "gpt 5.1 (chatgpt subscription)": "gpt-5.1",

  // Legacy GPT-5 Codex
  "gpt-5-codex": "gpt-5.1-codex",
  "gpt-5-codex-low": "gpt-5.1-codex",
  "gpt-5-codex-medium": "gpt-5.1-codex",
  "gpt-5-codex-high": "gpt-5.1-codex",
  "gpt 5 codex": "gpt-5.1-codex",
  "gpt 5 codex low": "gpt-5.1-codex",
  "gpt 5 codex (chatgpt subscription)": "gpt-5.1-codex",
  "gpt 5 codex low (chatgpt subscription)": "gpt-5.1-codex",

  // Legacy GPT-5
  "gpt-5": "gpt-5.1",
  "gpt-5-low": "gpt-5.1",
  "gpt-5-medium": "gpt-5.1",
  "gpt-5-high": "gpt-5.1",
  "gpt 5": "gpt-5.1",
  "gpt 5 (chatgpt subscription)": "gpt-5.1",
};

/**
 * Get normalized model name from model map
 * @param {string} modelId - Model ID from config
 * @returns {string|undefined} Normalized model name or undefined if not found
 */
function getNormalizedModel(modelId) {
  if (!modelId) return undefined;
  const key = modelId.toLowerCase();
  return MODEL_MAP[key];
}

/**
 * Normalize model name to Codex-supported variants
 * @param {string|undefined} model - Original model name
 * @returns {string} Normalized model name
 */
function normalizeModel(model) {
  if (!model) return "gpt-5.1";

  // Strip provider prefix if present (e.g., "openai/gpt-5-codex" → "gpt-5-codex")
  const modelId = model.includes("/") ? model.split("/").pop() : model;

  // Try explicit model map first
  const mappedModel = getNormalizedModel(modelId);
  if (mappedModel) return mappedModel;

  // Fallback: Pattern-based matching
  const normalized = modelId.toLowerCase();

  if (normalized.includes("gpt-5.2-codex") || normalized.includes("gpt 5.2 codex")) {
    return "gpt-5.2-codex";
  }
  if (normalized.includes("gpt-5.2") || normalized.includes("gpt 5.2")) {
    return "gpt-5.2";
  }
  if (normalized.includes("gpt-5.1-codex-max") || normalized.includes("gpt 5.1 codex max")) {
    return "gpt-5.1-codex-max";
  }
  if (normalized.includes("gpt-5.1-codex-mini") || normalized.includes("gpt 5.1 codex mini")) {
    return "gpt-5.1-codex-mini";
  }
  if (normalized.includes("codex-mini-latest") || normalized.includes("gpt-5-codex-mini") || normalized.includes("gpt 5 codex mini")) {
    return "codex-mini-latest";
  }
  if (normalized.includes("gpt-5.1-codex") || normalized.includes("gpt 5.1 codex")) {
    return "gpt-5.1-codex";
  }
  if (normalized.includes("gpt-5.1") || normalized.includes("gpt 5.1")) {
    return "gpt-5.1";
  }
  if (normalized.includes("codex")) {
    return "gpt-5.1-codex";
  }
  if (normalized.includes("gpt-5") || normalized.includes("gpt 5")) {
    return "gpt-5.1";
  }

  return "gpt-5.1";
}

// ============================================================================
// CODEX INSTRUCTIONS
// ============================================================================

/**
 * Get model family for instruction lookup
 * @param {string} model - Model name
 * @returns {string} Model family (gpt_5_1_codex, gpt_5_2_codex, gpt_5_1, etc.)
 */
function getModelFamily(model) {
  const m = (model || "").toLowerCase();

  if (m.includes("gpt-5.2-codex") || m.includes("gpt 5.2 codex")) return "gpt_5_2_codex";
  if (m.includes("gpt-5.2") || m.includes("gpt 5.2")) return "gpt_5_2";
  if (m.includes("gpt-5.1-codex-max") || m.includes("gpt 5.1 codex max")) return "gpt_5_1_codex_max";
  if (m.includes("gpt-5.1-codex-mini") || m.includes("gpt 5.1 codex mini")) return "gpt_5_1_codex_mini";
  if (m.includes("codex-mini") || m.includes("codex mini")) return "codex_mini";
  if (m.includes("gpt-5.1-codex") || m.includes("gpt 5.1 codex")) return "gpt_5_1_codex";
  if (m.includes("gpt-5.1") || m.includes("gpt 5.1")) return "gpt_5_1";
  if (m.includes("codex")) return "gpt_5_1_codex";
  if (m.includes("gpt-5") || m.includes("gpt 5")) return "gpt_5_1";

  return "gpt_5_1_codex";
}

// Instructions cache: Map<family, { instructions, etag, fetchedAt }>
const instructionsCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Cached release tag
let cachedReleaseTag = null;
let releaseTagFetchedAt = 0;
const RELEASE_TAG_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Get latest release tag from GitHub
 * @returns {Promise<string>} Release tag (e.g., "v1.0.0")
 */
async function getLatestReleaseTag() {
  if (cachedReleaseTag && releaseTagFetchedAt > Date.now() - RELEASE_TAG_TTL_MS) {
    return cachedReleaseTag;
  }

  try {
    const res = await fetch(GITHUB_API, {
      headers: { "User-Agent": "tintin-chatgpt-proxy" },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const json = await res.json();
      if (json.tag_name) {
        cachedReleaseTag = json.tag_name;
        releaseTagFetchedAt = Date.now();
        return cachedReleaseTag;
      }
    }
  } catch (e) {
    log(`getLatestReleaseTag failed: ${e.message}`);
  }

  return cachedReleaseTag || "main";
}

/**
 * Fallback instructions when GitHub fetch fails
 */
const FALLBACK_INSTRUCTIONS = `You are an expert software engineer assistant helping the user with their coding tasks.
Be concise and precise. Follow best practices for the language and framework being used.`;

/**
 * Get Codex instructions for a model, with caching
 * @param {string} model - Model name
 * @returns {Promise<string>} Codex instructions
 */
async function getCodexInstructions(model) {
  const family = getModelFamily(model);
  const cached = instructionsCache.get(family);

  if (cached && cached.fetchedAt > Date.now() - CACHE_TTL_MS) {
    return cached.instructions;
  }

  try {
    const tag = await getLatestReleaseTag();
    const url = `${GITHUB_RAW}/${tag}/codex-rs/core/${family}_prompt.md`;

    const headers = { "User-Agent": "tintin-chatgpt-proxy" };
    if (cached?.etag) {
      headers["If-None-Match"] = cached.etag;
    }

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 304 && cached) {
      // Not modified, update fetchedAt
      cached.fetchedAt = Date.now();
      return cached.instructions;
    }

    if (res.ok) {
      const instructions = await res.text();
      const etag = res.headers.get("etag");
      instructionsCache.set(family, { instructions, etag, fetchedAt: Date.now() });
      log(`fetched instructions for ${family} (${instructions.length} chars)`);
      return instructions;
    }
  } catch (e) {
    log(`getCodexInstructions failed for ${family}: ${e.message}`);
  }

  return cached?.instructions || FALLBACK_INSTRUCTIONS;
}

// ============================================================================
// TOOL REMAP MESSAGE
// ============================================================================

const TOOL_REMAP_MESSAGE = `IMPORTANT: If you see tool names in Codex prompts that don't match your available tools, use these replacements:
- apply_patch → edit (for file modifications)
- update_plan → todowrite (for task management)
- read_plan → todoread (for reading tasks)
Use the tools available to you, not the ones mentioned in instructions.`;

// ============================================================================
// INPUT FILTERING
// ============================================================================

/**
 * Filter input array for stateless Codex API (store: false)
 *
 * Removes:
 * - item_reference (AI SDK-specific, not in OpenAI Responses API spec)
 * - IDs from all items (stateless mode)
 *
 * @param {Array|undefined} input - Original input array
 * @returns {Array|undefined} Filtered input array
 */
function filterInput(input) {
  if (!Array.isArray(input)) return input;

  return input
    .filter((item) => {
      // Remove AI SDK constructs not supported by Codex API
      if (item.type === "item_reference") return false;
      return true;
    })
    .map((item) => {
      // Strip IDs from all items (Codex API stateless mode)
      if (item.id) {
        const { id, ...itemWithoutId } = item;
        return itemWithoutId;
      }
      return item;
    });
}

/**
 * Normalize orphaned function_call_output items.
 * When function_call was an item_reference that got filtered,
 * the output becomes orphaned. Convert to message to preserve context.
 *
 * @param {Array} input - Input array
 * @returns {Array} Normalized input array
 */
function normalizeOrphanedToolOutputs(input) {
  if (!Array.isArray(input)) return input;

  const callIds = new Set();
  for (const item of input) {
    if (item.type === "function_call" && item.call_id) {
      callIds.add(item.call_id);
    }
  }

  return input.map((item) => {
    if (item.type === "function_call_output" && item.call_id && !callIds.has(item.call_id)) {
      // Convert orphaned output to a message
      return {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `[Tool output for ${item.call_id}]: ${typeof item.output === "string" ? item.output : JSON.stringify(item.output)}`,
          },
        ],
      };
    }
    return item;
  });
}

/**
 * Add tool remapping message to input if tools are present
 * @param {Array|undefined} input - Input array
 * @param {boolean} hasTools - Whether tools are present in request
 * @returns {Array|undefined} Input array with tool remap message prepended
 */
function addToolRemapMessage(input, hasTools) {
  if (!hasTools || !Array.isArray(input)) return input;

  const toolRemapMessageItem = {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: TOOL_REMAP_MESSAGE }],
  };

  return [toolRemapMessageItem, ...input];
}

// ============================================================================
// REASONING CONFIG
// ============================================================================

/**
 * Get reasoning configuration for a model
 * @param {string|undefined} modelName - Model name
 * @returns {{ effort: string, summary: string }} Reasoning config
 */
function getReasoningConfig(modelName) {
  const normalized = (modelName || "").toLowerCase();

  const isGpt52Codex = normalized.includes("gpt-5.2-codex") || normalized.includes("gpt 5.2 codex");
  const isGpt52General = (normalized.includes("gpt-5.2") || normalized.includes("gpt 5.2")) && !isGpt52Codex;
  const isCodexMax = normalized.includes("codex-max") || normalized.includes("codex max");
  const isCodexMini = normalized.includes("codex-mini") || normalized.includes("codex mini") || normalized.includes("codex-mini-latest");
  const isCodex = normalized.includes("codex") && !isCodexMini;
  const isLightweight = !isCodexMini && (normalized.includes("nano") || normalized.includes("mini"));
  const isGpt51General = (normalized.includes("gpt-5.1") || normalized.includes("gpt 5.1")) && !isCodex && !isCodexMax && !isCodexMini;

  const supportsXhigh = isGpt52General || isGpt52Codex || isCodexMax;
  const supportsNone = isGpt52General || isGpt51General;

  // Default effort based on model type
  let effort = isCodexMini ? "medium" : supportsXhigh ? "high" : isLightweight ? "low" : "medium";

  // Codex Mini constraints
  if (isCodexMini) {
    if (effort === "minimal" || effort === "low" || effort === "none") effort = "medium";
    if (effort === "xhigh") effort = "high";
    if (effort !== "high" && effort !== "medium") effort = "medium";
  }

  // Downgrade xhigh if not supported
  if (!supportsXhigh && effort === "xhigh") effort = "high";

  // Upgrade none if not supported
  if (!supportsNone && effort === "none") effort = "low";

  // Normalize minimal to low
  if (effort === "minimal") effort = "low";

  return { effort, summary: "auto" };
}

// ============================================================================
// REQUEST TRANSFORMER
// ============================================================================

/**
 * Transform request body for Codex API
 *
 * @param {object} body - Original request body
 * @param {string} codexInstructions - Codex system instructions
 * @returns {Promise<object>} Transformed request body
 */
async function transformRequestBody(body, codexInstructions) {
  const transformed = { ...body };

  // 1. Normalize model name
  transformed.model = normalizeModel(body.model);

  // 2. Codex required fields
  transformed.store = false; // ChatGPT backend REQUIRES store=false
  transformed.stream = true; // Always stream

  // 3. Set instructions
  transformed.instructions = codexInstructions;

  // 4. Filter and transform input
  if (transformed.input && Array.isArray(transformed.input)) {
    transformed.input = filterInput(transformed.input);
    transformed.input = addToolRemapMessage(transformed.input, !!transformed.tools);
    transformed.input = normalizeOrphanedToolOutputs(transformed.input);
  }

  // 5. Configure reasoning
  transformed.reasoning = getReasoningConfig(transformed.model);

  // 6. Configure text verbosity (medium is Codex CLI default)
  transformed.text = { verbosity: "medium" };

  // 7. Add include for encrypted reasoning content
  // Required for stateless operation with store=false
  transformed.include = ["reasoning.encrypted_content"];

  // 8. Remove unsupported parameters
  delete transformed.max_output_tokens;
  delete transformed.max_completion_tokens;

  return transformed;
}

// ============================================================================
// LOGGING
// ============================================================================

function log(msg) {
  const ts = new Date().toISOString();
  console.error(`${LOG_PREFIX} ts=${ts} ${msg}`);
}

async function logRefresh(payload) {
  const data = { refreshed: true, ...payload };
  process.stdout.write(`${REFRESH_PREFIX} ${JSON.stringify(data)}\n`);
  if (REFRESH_OUT) {
    try {
      await fs.promises.writeFile(REFRESH_OUT, `${JSON.stringify(data)}\n`, "utf8");
    } catch (err) {
      log(`refresh persist failed: ${String(err)}`);
    }
  }
}

function redactToken(token) {
  if (!token) return "(empty)";
  return `len=${token.length}`;
}

// ============================================================================
// TOKEN REFRESH
// ============================================================================

function isExpiringSoon() {
  if (!expiresAt) return false;
  return expiresAt <= Date.now() + 60_000; // 1 minute margin
}

async function refreshOnce(reason) {
  if (!refreshToken) throw new Error("missing refresh token");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  log(`refresh start reason=${reason}`);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`refresh failed status=${res.status} body=${text.slice(0, 200)}`);
  }

  const json = await res.json();
  if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== "number") {
    throw new Error("refresh response missing fields");
  }

  accessToken = json.access_token;
  refreshToken = json.refresh_token;
  expiresAt = Date.now() + json.expires_in * 1000;

  log(`refresh ok access=${redactToken(accessToken)} exp=${new Date(expiresAt).toISOString()}`);

  await logRefresh({
    account_id: ACCOUNT_ID,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
  });
}

// ============================================================================
// URL REWRITING
// ============================================================================

function buildUpstreamUrl(pathname, search) {
  let path = pathname || "/";
  if (path === "/v1") path = "/";
  if (path.startsWith("/v1/")) path = path.slice(3);
  // Rewrite /responses to /codex/responses
  const targetPath = path === "/responses" || path.includes("/responses")
    ? path.replace("/responses", "/codex/responses")
    : path;
  return {
    url: `${UPSTREAM_BASE}${targetPath}${search ? `?${search}` : ""}`,
    originalPath: pathname || "/",
    targetPath,
  };
}

// ============================================================================
// HEADERS
// ============================================================================

function createCodexHeaders(originalHeaders, opts) {
  const headers = new Headers(originalHeaders);
  // Remove hop-by-hop headers or values that become invalid after rewriting.
  for (const key of [
    "content-length",
    "content-encoding",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "proxy-connection",
    "upgrade",
    "host",
    "accept-encoding",
    "te",
    "trailer",
  ]) {
    headers.delete(key);
  }
  headers.delete("x-api-key");
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("chatgpt-account-id", ACCOUNT_ID);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("originator", "codex_cli_rs");
  headers.set("accept", "text/event-stream");
  headers.set("Content-Type", "application/json");
  const cacheKey = opts?.promptCacheKey;
  if (cacheKey) {
    headers.set("conversation_id", cacheKey);
    headers.set("session_id", cacheKey);
  } else {
    headers.delete("conversation_id");
    headers.delete("session_id");
  }
  return headers;
}

// ============================================================================
// ERROR HANDLING
// ============================================================================

/**
 * Map 404 with usage_limit_reached to 429 for retryable error handling
 * @param {Response} response - Fetch response
 * @returns {Promise<Response|null>} Mapped response or null
 */
async function mapUsageLimit404(response) {
  if (response.status !== 404) return null;

  const clone = response.clone();
  let text = "";
  try {
    text = await clone.text();
  } catch {
    return null;
  }
  if (!text) return null;

  let code = "";
  try {
    const parsed = JSON.parse(text);
    code = (parsed?.error?.code ?? parsed?.error?.type ?? "").toString();
  } catch {
    code = "";
  }

  const haystack = `${code} ${text}`.toLowerCase();
  if (!/usage_limit_reached|usage_not_included|rate_limit_exceeded|usage limit/i.test(haystack)) {
    return null;
  }

  log(`mapping 404 usage limit to 429`);
  return new Response(text, {
    status: 429,
    statusText: "Too Many Requests",
    headers: response.headers,
  });
}

async function summarizeErrorResponse(response) {
  try {
    const clone = response.clone();
    const text = await clone.text();
    if (!text) return "(empty)";
    try {
      const parsed = JSON.parse(text);
      const msg = parsed?.error?.message ?? parsed?.message ?? parsed?.error ?? "";
      if (typeof msg === "string" && msg.trim().length > 0) {
        return truncateOneLine(msg.trim(), 240);
      }
      return truncateOneLine(text, 240);
    } catch {
      return truncateOneLine(text, 240);
    }
  } catch {
    return "(unreadable)";
  }
}

function truncateOneLine(text, max) {
  const cleaned = String(text).replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1))}…`;
}

function emitProxyError(message, extra) {
  try {
    const payload = {
      type: "error",
      message,
      source: "chatgpt_proxy",
      ...extra,
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // Ignore logging failures.
  }
}

// ============================================================================
// REQUEST FORWARDING
// ============================================================================

async function forwardOnce(req, bodyBuffer, { retryOn401 }) {
  const upstream = buildUpstreamUrl(req.pathname, req.search);

  // Transform request body if present
  let transformedBody = bodyBuffer;
  let promptCacheKey = "";
  if (bodyBuffer && bodyBuffer.length > 0) {
    try {
      const bodyJson = JSON.parse(bodyBuffer.toString("utf8"));
      const normalizedModel = normalizeModel(bodyJson.model);
      const instructions = await getCodexInstructions(normalizedModel);
      const transformed = await transformRequestBody(bodyJson, instructions);
      promptCacheKey = typeof transformed.prompt_cache_key === "string" ? transformed.prompt_cache_key : "";
      transformedBody = JSON.stringify(transformed);
      log(`transformed request: model=${bodyJson.model} → ${transformed.model}, reasoning=${JSON.stringify(transformed.reasoning)}`);
    } catch (e) {
      log(`body transform failed, using original: ${e.message}`);
    }
  }
  const headers = createCodexHeaders(req.headers, { promptCacheKey });
  if (promptCacheKey) {
    log(`using prompt_cache_key=${promptCacheKey}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(upstream.url, {
      method: req.method,
      headers,
      body: transformedBody,
      signal: controller.signal,
    });

    if (res.status === 401 && retryOn401) {
      await refreshOnce("401");
      return forwardOnce(req, bodyBuffer, { retryOn401: false });
    }

    if (!res.ok) {
      const detail = await summarizeErrorResponse(res);
      const requestId =
        res.headers.get("x-request-id") ||
        res.headers.get("x-openai-request-id") ||
        res.headers.get("x-requestid") ||
        "";
      const cfRay = res.headers.get("cf-ray") || "";
      const message = `upstream error status=${res.status} path=${upstream.originalPath} target=${upstream.targetPath} detail=${detail}`;
      log(message);
      emitProxyError(message, {
        status: res.status,
        path: upstream.originalPath,
        target: upstream.targetPath,
        request_id: requestId || undefined,
        cf_ray: cfRay || undefined,
      });
    }

    // Check for usage limit 404 → 429 mapping
    const mapped = await mapUsageLimit404(res);
    if (mapped) return mapped;

    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const message = `upstream fetch failed path=${upstream.originalPath} target=${upstream.targetPath} error=${truncateOneLine(msg, 200)}`;
    log(message);
    emitProxyError(message, { path: upstream.originalPath, target: upstream.targetPath });
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================================
// HTTP HANDLER
// ============================================================================

async function handler(req, res) {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);

    // Read request body
    const bodyBuffer = req.method === "GET" || req.method === "HEAD"
      ? undefined
      : await new Promise((resolve) => {
          const chunks = [];
          req.on("data", (c) => chunks.push(c));
          req.on("end", () => resolve(Buffer.concat(chunks)));
          req.on("error", () => resolve(undefined));
        });

    // Check auth
    if (!accessToken || !refreshToken || !ACCOUNT_ID) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("ChatGPT auth missing. Please /connect chatgpt.");
      return;
    }

    // Proactive token refresh (before each request)
    if (isExpiringSoon()) {
      try {
        await refreshOnce("preflight");
      } catch (e) {
        log(`refresh preflight failed: ${e.message}`);
      }
    }

    // Forward request
    const upstreamRes = await forwardOnce(
      {
        method: req.method,
        pathname: urlObj.pathname,
        search: urlObj.searchParams.toString(),
        headers: req.headers,
      },
      bodyBuffer,
      { retryOn401: true }
    );

    // Send response
    res.writeHead(upstreamRes.status, Object.fromEntries(upstreamRes.headers));
    if (upstreamRes.body) {
      // Node.js fetch returns a web ReadableStream, need to pipe properly
      const reader = upstreamRes.body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              res.end();
              break;
            }
            res.write(value);
          }
        } catch (e) {
          log(`stream error: ${e.message}`);
          res.end();
        }
      };
      pump();
    } else {
      res.end();
    }

    log(`proxy ${req.method} ${urlObj.pathname} -> ${upstreamRes.status}`);
  } catch (e) {
    log(`proxy error: ${e.message}`);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("proxy error");
  }
}

// ============================================================================
// SERVER
// ============================================================================

const server = http.createServer(handler);
server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT} account=${ACCOUNT_ID || "(none)"} access=${redactToken(accessToken)}`);
});

process.on("uncaughtException", (err) => {
  log(`uncaughtException: ${err.message}`);
});
process.on("unhandledRejection", (err) => {
  log(`unhandledRejection: ${String(err)}`);
});
