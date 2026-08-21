import { getAdapter } from "../driver.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 5 * 1024;
const FULL_BODY_MAX_SIZE = 2 * 1024 * 1024; // 2MB disk cache for "Show Full" / Download
const FULL_BODY_MAX_FILES = 20;
const FULL_BODY_DIR = path.join(os.tmpdir(), "9router-full-bodies");
const CONFIG_CACHE_TTL_MS = 5000;

let cachedConfig = null;
let cachedConfigTs = 0;

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    const envEnabled = process.env.OBSERVABILITY_ENABLED !== "false";
    const enabled = typeof settings.enableObservability2 === "boolean"
      ? settings.enableObservability2
      : envEnabled;
    cachedConfig = {
      enabled,
      maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "50", 10)) * 1024,
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

let writeBuffer = [];
let flushTimer = null;
let isFlushing = false;

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token", "api-key"];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) delete sanitized[key];
  }
  return sanitized;
}

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

function truncateField(obj, maxSize) {
  const str = JSON.stringify(obj || {});
  if (str.length > maxSize) {
    return { _truncated: true, _originalSize: str.length, _preview: str.substring(0, 2000) };
  }
  return obj || {};
}

// Recursively search an object for a gateway/upstream cost field.
// ClinePass and similar upstreams return the real cost in provider_metadata.gateway.cost,
// which is more accurate than pricing-table estimation (and works even when usage extraction fails).
function extractGatewayCost(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return 0;
  const gw = obj.gateway || obj.provider_metadata?.gateway || obj.providerMetadata?.gateway;
  if (gw && typeof gw === "object") {
    for (const k of ["cost", "gatewayCost", "inferenceCost"]) {
      const v = gw[k];
      if (typeof v === "number" && v > 0) return v;
      if (typeof v === "string" && parseFloat(v) > 0) return parseFloat(v);
    }
  }
  for (const v of Object.values(obj)) {
    const c = extractGatewayCost(v, depth + 1);
    if (c > 0) return c;
  }
  return 0;
}

// Full-body disk cache (up to 50KB each, ring-buffer of 20)
function getFullBodyPath(id) {
  try { fs.mkdirSync(FULL_BODY_DIR, { recursive: true }); } catch {}
  return path.join(FULL_BODY_DIR, id.replace(/[^a-zA-Z0-9._-]/g, "_") + ".json");
}

function saveFullBody(id, obj) {
  try {
    const str = JSON.stringify(obj || {});
    if (str.length > FULL_BODY_MAX_SIZE) return; // too big, skip
    fs.writeFileSync(getFullBodyPath(id), str, "utf-8");
    // Ring buffer cleanup
    const files = fs.readdirSync(FULL_BODY_DIR)
      .map(f => ({ name: f, mtime: fs.statSync(path.join(FULL_BODY_DIR, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    while (files.length > FULL_BODY_MAX_FILES) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(FULL_BODY_DIR, oldest.name)); } catch {}
    }
  } catch {}
}

function loadFullBody(id) {
  try {
    const p = getFullBodyPath(id);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { return null; }
}

// Suffix → requestDetail field name mapping (for SQLite fallback when disk cache misses)
const BODY_SUFFIX_FIELD = {
  "": "request",
  "_preq": "providerRequest",
  "_pres": "providerResponse",
  "_resp": "response",
};

// Fallback for old requests (pre-disk-cache): return the SQLite-stored field.
// If the field was truncated, returns { _truncated, _originalSize, _preview } object.
async function loadBodyFromSqlite(id) {
  let suffix = "";
  let baseId = id;
  for (const s of ["_preq", "_pres", "_resp"]) {
    if (id.endsWith(s)) { suffix = s; baseId = id.slice(0, -s.length); break; }
  }
  const field = BODY_SUFFIX_FIELD[suffix];
  if (!field) return null;
  try {
    const db = await getAdapter();
    const row = db.get(`SELECT data FROM requestDetails WHERE id = ?`, [baseId]);
    if (!row) return null;
    const parsed = parseJson(row.data, {});
    const val = parsed[field];
    if (val == null) return null;
    return val;
  } catch { return null; }
}

// Try disk cache first; fall back to SQLite-stored field for old requests.
async function loadFullBodyWithFallback(id) {
  const disk = loadFullBody(id);
  if (disk != null) return { data: disk, source: "disk" };
  const sqlite = await loadBodyFromSqlite(id);
  if (sqlite != null) return { data: sqlite, source: "sqlite-preview" };
  return null;
}


async function flushToDatabase() {
  if (isFlushing) return;
  if (writeBuffer.length === 0) return;
  isFlushing = true;
  try {      // Drain entire buffer (loop in case more pushed during await)
      while (writeBuffer.length > 0) {
        const items = writeBuffer.splice(0, writeBuffer.length);
        const db = await getAdapter();
        const config = await getObservabilityConfig();

        // Precompute cost per item (async; outside the sync transaction)
        let calcCost;
        try {
          const mod = await import("./usageRepo.js");
          calcCost = mod.calculateCost;
        } catch { calcCost = null; }
        for (const item of items) {
          try {
            // Prefer real upstream gateway cost (most accurate); fall back to pricing-table calc
            const gwCost = extractGatewayCost(item.response) || extractGatewayCost(item.providerResponse);
            item.cost = gwCost > 0
              ? gwCost
              : calcCost
                ? await calcCost(item.provider, item.model, item.tokens)
                : 0;
          } catch { item.cost = 0; }
        }

        db.transaction(() => {
        for (const item of items) {
          if (!item.id) item.id = generateDetailId(item.model);
          if (!item.timestamp) item.timestamp = new Date().toISOString();
          if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);

          // Save full bodies to disk cache (up to 50KB) before truncation
          const fullId = item.id || generateDetailId(item.model);
          saveFullBody(fullId, item.request);
          saveFullBody(fullId + "_preq", item.providerRequest);
          saveFullBody(fullId + "_pres", item.providerResponse);
          saveFullBody(fullId + "_resp", item.response);

          const record = {
            id: item.id,
            provider: item.provider || null,
            model: item.model || null,
            connectionId: item.connectionId || null,
            timestamp: item.timestamp,
            status: item.status || null,
            latency: item.latency || {},
            tokens: item.tokens || {},
            cost: item.cost || 0,
            request: truncateField(item.request, config.maxJsonSize),
            providerRequest: truncateField(item.providerRequest, config.maxJsonSize),
            providerResponse: truncateField(item.providerResponse, config.maxJsonSize),
            response: truncateField(item.response, config.maxJsonSize),
          };

          db.run(
            `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data`,
            [record.id, record.timestamp, record.provider, record.model, record.connectionId, record.status, stringifyJson(record)]
          );
        }

        const cnt = db.get(`SELECT COUNT(*) as c FROM requestDetails`);
        if (cnt && cnt.c > config.maxRecords) {
          db.run(
            `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
            [cnt.c - config.maxRecords]
          );
        }
      });
    }
  } catch (e) {
    console.error("[requestDetailsRepo] Batch write failed:", e);
  } finally {
    isFlushing = false;
  }
}

export async function saveRequestDetail(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) return;

  writeBuffer.push(detail);

  // Trigger immediate flush if batch threshold reached.
  // flushToDatabase() drains entire buffer in a loop, so all pushes during await are persisted.
  if (writeBuffer.length >= config.batchSize) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushToDatabase().catch((e) => console.error("[requestDetailsRepo] flush err:", e));
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushToDatabase().catch(() => {});
    }, config.flushIntervalMs);
  }
}

export async function getRequestDetails(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.connectionId) { conds.push("connectionId = ?"); params.push(filter.connectionId); }
  if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.all(
    `SELECT data FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const details = rows.map((r) => parseJson(r.data, {}));

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export async function getRequestDetailById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestDetails WHERE id = ?`, [id]);
  return row ? parseJson(row.data, null) : null;
}

const _shutdownHandler = async () => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (writeBuffer.length > 0) await flushToDatabase();
};

function ensureShutdownHandler() {
  process.off("beforeExit", _shutdownHandler);
  process.off("SIGINT", _shutdownHandler);
  process.off("SIGTERM", _shutdownHandler);
  process.off("exit", _shutdownHandler);

  process.on("beforeExit", _shutdownHandler);
  process.on("SIGINT", _shutdownHandler);
  process.on("SIGTERM", _shutdownHandler);
  process.on("exit", _shutdownHandler);
}

ensureShutdownHandler();

export { loadFullBody, loadFullBodyWithFallback };
