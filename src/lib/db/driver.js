import fs from "node:fs";
import { ensureDirs, DATA_FILE } from "./paths.js";

// A brand-new DB (schema only) is ~176KB. Anything meaningfully larger holds
// real data we must not let the in-memory sql.js driver overwrite on flush.
const POPULATED_DB_BYTES = 300 * 1024;

// Use global to survive Next.js dev hot-reload (module state resets on reload)
if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false };
const state = global._dbAdapter;

async function tryBunSqlite() {
  // Bun runtime only — built-in, no install needed
  if (!process.versions.bun) return null;
  try {
    const { createBunSqliteAdapter } = await import("./adapters/bunSqliteAdapter.js");
    return await createBunSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] bun:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function tryBetterSqlite() {
  // Skip on Bun — better-sqlite3 native bindings unsupported
  if (process.versions.bun) return null;
  try {
    const { createBetterSqliteAdapter } = await import("./adapters/betterSqliteAdapter.js");
    return createBetterSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] better-sqlite3 unavailable: ${e.message}`);
    return null;
  }
}

async function tryNodeSqlite() {
  // Built-in since Node 22.5.0 — no install needed. Skip under Bun (no node:sqlite).
  if (process.versions.bun) return null;
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) return null;
  try {
    const { createNodeSqliteAdapter } = await import("./adapters/nodeSqliteAdapter.js");
    return await createNodeSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] node:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function trySqlJs() {
  try {
    const { createSqlJsAdapter } = await import("./adapters/sqljsAdapter.js");
    return await createSqlJsAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] sql.js unavailable: ${e.message}`);
    return null;
  }
}

async function initAdapter() {
  ensureDirs();
  // Order per runtime:
  //   Bun:  bun:sqlite → sql.js
  //   Node: better-sqlite3 → node:sqlite (≥22.5) → sql.js
  let adapter = await tryBunSqlite();
  if (!adapter) adapter = await tryBetterSqlite();
  if (!adapter) adapter = await tryNodeSqlite();

  // DATA-LOSS GUARD: sql.js is an in-memory driver — it loads data.sqlite into
  // RAM and flushes the whole file back on write. If a native driver failed
  // (almost always a Node ABI mismatch: better-sqlite3 built for a different
  // Node major) AND a populated DB already exists, falling back to sql.js can
  // overwrite that file with an empty/stale image. That is exactly how the DB
  // got wiped once. Refuse to continue and fail LOUD instead. Fresh/tiny DBs
  // (new installs, Bun-only envs) still fall back to sql.js fine.
  if (!adapter) {
    let existingBytes = 0;
    try { existingBytes = fs.existsSync(DATA_FILE) ? fs.statSync(DATA_FILE).size : 0; } catch { /* ignore */ }
    if (existingBytes > POPULATED_DB_BYTES) {
      throw new Error(
        `[DB] Refusing sql.js fallback to protect data: no native SQLite driver loaded ` +
        `(better-sqlite3 / node:sqlite both unavailable) but a populated DB exists ` +
        `(${DATA_FILE}, ${existingBytes} bytes). This is almost always a Node ABI mismatch — ` +
        `run under the Node version better-sqlite3 was built for (v22 / hermes) or ` +
        `'npm rebuild better-sqlite3'. Aborting so sql.js does not overwrite your data.`
      );
    }
    adapter = await trySqlJs();
  }

  if (!adapter) throw new Error("[DB] No SQLite driver available (bun/better/node/sql.js all failed)");

  if (!state.logged) {
    console.log(`[DB] Driver: ${adapter.driver} | file: ${DATA_FILE}`);
    state.logged = true;
  }

  const { runMigrationOnce } = await import("./migrate.js");
  await runMigrationOnce(adapter);
  return adapter;
}

export async function getAdapter() {
  if (state.instance) return state.instance;
  if (!state.initPromise) state.initPromise = initAdapter().then((a) => { state.instance = a; return a; });
  return state.initPromise;
}

export function getAdapterSync() {
  if (!state.instance) throw new Error("[DB] adapter not initialized — await getAdapter() first");
  return state.instance;
}
