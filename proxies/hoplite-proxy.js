#!/usr/bin/env node
/**
 * hoplite-proxy.js — Hoplite agent bridge for 9Router (:8010)
 *
 * Speaks OpenAI /v1/chat/completions + /v1/models toward 9Router; talks the
 * Hoplite platform API (https://api.hoplite.sh) upstream. A "chat completion"
 * maps to a Hoplite coding-agent run:
 *
 *   1. Conversation-hash cache → reuse an existing thread (append last user
 *      message) or create a new thread with the whole conversation flattened.
 *   2. Poll GET /api/threads/:id/messages — stream thinking/tool/status
 *      messages live as reasoning_content deltas (tabbit lesson: stream the
 *      wait, don't hang silently for minutes).
 *   3. When the thread leaves the running state, the last assistant chat
 *      message is the answer → streamed as content.
 *
 * CommandCode-derived hygiene baked in:
 *   - NEVER fake success: run failure / timeout / credit exhaustion returns a
 *     real HTTP 5xx (before content) so 9router's failover path fires.
 *   - Per-conversation isolation (thread keyed by conversation hash), per-run
 *     idempotency ids (clientOperationId / clientMessageId).
 *   - Real upstream error bodies forwarded with x-request-id for correlation.
 *
 * Config: %APPDATA%\9router\hoplite-proxy.json  (NOT in this git repo)
 *   { "apiKey": "hop_...", "projectId": "proj_...", "port": 8010,
 *     "pollMs": 3000, "runTimeoutMs": 900000, "defaultModel": "gpt-5.6-terra" }
 * Env fallback: HOPLITE_API_KEY, HOPLITE_PROJECT_ID.
 */

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs");

// ---------------------------------------------------------------- config --
function loadConfig() {
  const cfgPath = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "9router", "hoplite-proxy.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")); } catch (_) {}
  const apiKey = cfg.apiKey || process.env.HOPLITE_API_KEY || "";
  const legacy = cfg.apiKey ? [{ name: "primary", apiKey: cfg.apiKey, projectId: cfg.projectId || "", minCredits: cfg.minCredits }] : [];
  const keys = (Array.isArray(cfg.keys) && cfg.keys.length ? cfg.keys : legacy).map((k, i) => ({
    name: k.name || `key${i}`,
    apiKey: k.apiKey || "",
    projectId: k.projectId || "",
    minCredits: k.minCredits === undefined ? undefined : Number(k.minCredits),
  })).filter(k => k.apiKey);
  if (!keys.length) { console.error("[hoplite] FATAL: no keys in", cfgPath); process.exit(1); }
  if (keys.some(k => !k.projectId)) { console.error("[hoplite] FATAL: every key needs a projectId (org-scoped)", cfgPath); process.exit(1); }
  return {
    keys,
    port: Number(cfg.port || process.env.PORT || 8010),
    pollMs: Number(cfg.pollMs || 3000),
    runTimeoutMs: Number(cfg.runTimeoutMs || 15 * 60 * 1000),
    defaultModel: cfg.defaultModel || "z-ai/glm-5.3-flash",
    maxConcurrent: Number(cfg.maxConcurrent || 3), // Hoplite sandbox limit (nikita4a lesson)
    minCredits: Number(cfg.minCredits ?? 1), // default per-key breaker threshold ($)
    maxThreads: 100,
    threadTtlMs: 12 * 60 * 60 * 1000,
  };
}
const CFG = loadConfig();

// Serialize agent runs — Hoplite caps concurrent sandboxes; excess requests
// queue here instead of failing on upstream sandbox_limit errors.
const runQueue = []; // FIFO of {resolve}
let activeRuns = 0;
function acquireRunSlot() {
  if (activeRuns < CFG.maxConcurrent) { activeRuns++; return Promise.resolve(); }
  return new Promise((resolve) => runQueue.push({ resolve }));
}
function releaseRunSlot() {
  const next = runQueue.shift();
  if (next) next.resolve();
  else activeRuns = Math.max(0, activeRuns - 1);
}

const BASE = "https://api.hoplite.sh";
const stats = { requests: 0, runs: 0, errors: 0, contentChars: 0, startedAt: new Date().toISOString() };

// Bridge log file — serviceManager drops child stdout, so persist our own.
const LOG_FILE = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router", "logs", "hoplite-bridge.log");
function logLine(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch (_) {}
  console.log(msg);
}

// ------------------------------------------------------------ credits monitor --
// GET /api/billing/summary is undocumented (absent from openapi.json) but works
// with the org hop_ key. Polled per-key with a cache; drives per-key breakers.
const creditsByKey = CFG.keys.map(() => ({ data: null, at: 0, circuitOpen: false }));
const minCreditsFor = (i) => CFG.keys[i].minCredits ?? CFG.minCredits;
async function refreshCredits(idx, force = false) {
  const st = creditsByKey[idx];
  if (!force && st.data && Date.now() - st.at < 60000) return st.data;
  try {
    const r = await hopFetch("GET", "/api/billing/summary", undefined, { timeoutMs: 10000, apiKey: CFG.keys[idx].apiKey });
    if (r.status === 200 && r.json?.ok && r.json?.billing) {
      st.data = r.json.billing;
      st.at = Date.now();
      const remaining = Number(r.json.billing.remainingCredits);
      st.circuitOpen = Number.isFinite(remaining) && remaining < minCreditsFor(idx);
      if (st.circuitOpen) logLine(`CIRCUIT OPEN key[${idx}] ${CFG.keys[idx].name}: remaining ${remaining} < ${minCreditsFor(idx)}`);
    } else if (r.status === 401) {
      st.circuitOpen = true; // revoked key
      logLine(`key[${idx}] ${CFG.keys[idx].name}: 401 invalid — circuit open`);
    }
  } catch (_) { /* fail open: keep last known state */ }
  return st.data;
}
async function refreshAllCredits(force = false) {
  await Promise.all(CFG.keys.map((_, i) => refreshCredits(i, force)));
}
function creditsSnapshot() {
  return CFG.keys.map((k, i) => ({
    key: k.name,
    remaining: creditsByKey[i].data ? creditsByKey[i].data.remainingCredits : null,
    used: creditsByKey[i].data ? creditsByKey[i].data.usedCredits : null,
    included: creditsByKey[i].data ? creditsByKey[i].data.includedCredits : null,
    held: creditsByKey[i].data ? creditsByKey[i].data.heldCredits : null,
    nextResetAt: creditsByKey[i].data ? creditsByKey[i].data.nextResetAt : null,
    circuitOpen: creditsByKey[i].circuitOpen,
  }));
}
function allKeysOpen() { return creditsByKey.every(s => s.circuitOpen); }

// ------------------------------------------------------------ thread cache --
// key = keyIdx|projectId|model|sha256(prior conversation) -> {threadId, lastAt}
// Threads are org-scoped — the cache MUST be partitioned per key.
const threads = new Map();
function cacheKey(keyIdx, model, priorHash) { return `${keyIdx}|${CFG.keys[keyIdx].projectId}|${model}|${priorHash}`; }
function cacheGet(k) {
  const t = threads.get(k);
  if (!t) return null;
  if (Date.now() - t.lastAt > CFG.threadTtlMs) { threads.delete(k); return null; }
  t.lastAt = Date.now();
  return t.threadId;
}
function cachePut(k, threadId) {
  if (threads.size >= CFG.maxThreads) { // evict oldest
    let oldest = null;
    for (const [key, v] of threads) if (!oldest || v.lastAt < threads.get(oldest).lastAt) oldest = key;
    if (oldest) threads.delete(oldest);
  }
  threads.set(k, { threadId, lastAt: Date.now() });
}

// ------------------------------------------------------------------ fetch --
function hopFetch(method, urlPath, body, { timeoutMs = 30000, headers = {}, apiKey } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request(`${BASE}${urlPath}`, {
      method,
      headers: {
        "Authorization": `Bearer ${apiKey || (CFG.keys[0] && CFG.keys[0].apiKey) || ""}`,
        "Accept": "application/json",
        ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, json, text, requestId: res.headers["x-request-id"] || "" });
      });
    });
    req.on("timeout", () => req.destroy(new Error("upstream timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ------------------------------------------------------- message flattening --
function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === "string") return p;
      if (p.type === "text") return p.text || "";
      if (p.type === "image_url") {
        const u = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
        return u ? `[image: ${u}]` : "[image]";
      }
      if (p.type === "image") return `[image: ${p.source?.url || "inline"}]`;
      return "";
    }).filter(Boolean).join("\n");
  }
  return content == null ? "" : String(content);
}

function flattenConversation(messages) {
  // Full history rendered as a transcript for a fresh thread.
  const lines = [];
  for (const m of messages) {
    const role = m.role || "user";
    const txt = contentToText(m.content).trim();
    if (!txt) continue;
    if (role === "system" || role === "developer") lines.push(`### Instructions (system)\n${txt}`);
    else if (role === "assistant") lines.push(`### Previous assistant turn\n${txt}`);
    else if (role === "tool") lines.push(`### Tool result (${m.tool_call_id || "n/a"})\n${txt}`);
    else lines.push(`### User\n${txt}`);
  }
  return lines.join("\n\n");
}

function priorSignature(messages) {
  // Everything except the final message — the conversation identity.
  const prior = messages.slice(0, -1).map((m) => [m.role, contentToText(m.content)]);
  return crypto.createHash("sha256").update(JSON.stringify(prior)).digest("hex");
}

function continuationKey(keyIdx, model, messages, answer) {
  // Key for the NEXT turn: its prior = this conversation + our answer as last
  // assistant msg. Storing it lets follow-up turns append to the same thread
  // instead of re-sending the whole transcript into a fresh thread.
  const prior = messages.map((m) => [m.role, contentToText(m.content)]);
  prior.push(["assistant", answer]);
  return cacheKey(keyIdx, model, crypto.createHash("sha256").update(JSON.stringify(prior)).digest("hex"));
}

// ------------------------------------------------------------------ models --
// Per-key catalogs (org-scoped: friend orgs see 7 models, ours 17). Union is
// exposed via /v1/models; key selection prefers keys whose org has the model.
const catalogs = CFG.keys.map(() => ({ ids: null, at: 0 }));
const FALLBACK_MODELS = ["claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-opus-4-8",
  "claude-sonnet-5", "claude-haiku-4-5", "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
  "gpt-5.5", "gpt-5.3-codex", "meta/muse-spark-1.3", "moonshotai/kimi-k3", "z-ai/glm-5.3",
  "z-ai/glm-5.3-flash", "deepseek/deepseek-v4-flash-0731"];

async function catalogFor(idx, force = false) {
  const c = catalogs[idx];
  if (!force && c.ids && Date.now() - c.at < 5 * 60 * 1000) return c.ids;
  try {
    const r = await hopFetch("GET", "/api/model-providers", undefined, { timeoutMs: 15000, apiKey: CFG.keys[idx].apiKey });
    if (r.status === 200 && Array.isArray(r.json?.models)) {
      c.ids = r.json.models.map((m) => m.id).filter(Boolean);
      c.at = Date.now();
    }
  } catch (_) {}
  return c.ids;
}
async function listModels() {
  await Promise.all(CFG.keys.map((_, i) => catalogFor(i)));
  const union = new Set();
  for (const c of catalogs) for (const id of c.ids || []) union.add(id);
  if (!union.size) FALLBACK_MODELS.forEach((m) => union.add(m));
  return [...union];
}

// ------------------------------------------------------------- run lifecycle --
function msgText(m) {
  if (m == null) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return contentToText(m.content);
  if (m.text) return typeof m.text === "string" ? m.text : contentToText(m.text);
  return "";
}

const RUNNING_STATES = new Set(["queued", "running", "active", "pending", "in_progress", "working"]);
const FAILED_STATES = new Set(["failed", "error", "errored", "cancelled", "canceled", "timeout"]);

function classifyThreadState(thread) {
  const raw = thread?.status ?? thread?.state ?? thread?.runStatus ?? "";
  const s = String(raw).toLowerCase();
  if (!s) return { kind: "unknown", raw };
  if (RUNNING_STATES.has(s)) return { kind: "running", raw };
  if (FAILED_STATES.has(s)) return { kind: "failed", raw };
  return { kind: "done", raw };
}

/**
 * Drive one run to completion. Returns {ok, answer, reasoning, error, threadId}.
 * onDelta(type, text) — live streaming callback (type: "reasoning" | "content").
 */
async function driveRun(keyIdx, threadId, userMsgId, onDelta) {
  const apiKey = CFG.keys[keyIdx].apiKey;
  const started = Date.now();
  const seen = new Set([userMsgId].filter(Boolean));
  let answer = "";
  let reasoning = "";
  let lastAssistantText = "";
  let pollFails = 0;
  let lastStateRaw = "";
  let answerSettledSince = 0; // early-close: answer stable for 30s → finish (thread tail-lag workaround)

  while (Date.now() - started < CFG.runTimeoutMs) {
    let tr;
    try {
      tr = await hopFetch("GET", `/api/threads/${threadId}`, undefined, { apiKey });
      pollFails = 0;
    } catch (e) {
      if (++pollFails > 8) return { ok: false, error: `poll transport failure: ${e.message}` };
      await sleep(CFG.pollMs);
      continue;
    }
    if (tr.status === 429) { await sleep(Math.max(CFG.pollMs, 5000)); continue; }
    if (tr.status !== 200 || !tr.json?.thread) {
      if (++pollFails > 8) return { ok: false, error: `thread poll HTTP ${tr.status} ${tr.text?.slice(0, 160)} (req ${tr.requestId})` };
      await sleep(CFG.pollMs);
      continue;
    }

    // New messages → stream deltas (thinking/tool/status as reasoning progress).
    let mr;
    try {
      mr = await hopFetch("GET", `/api/threads/${threadId}/messages?limit=500`, undefined, { apiKey });
    } catch (e) { /* tolerate; next poll retries */ }
    if (mr?.status === 200 && Array.isArray(mr.json?.messages)) {
      const fresh = mr.json.messages.filter((m) => !seen.has(m.id));
      for (const m of fresh) {
        seen.add(m.id);
        const role = String(m.role || "").toLowerCase();
        const kind = String(m.kind || "").toLowerCase();
        const isAssistantChat = role === "assistant" && (kind === "chat" || kind === "" || kind === "message");
        const txt = msgText(m);
        if (isAssistantChat && txt) {
          if (txt !== lastAssistantText) {
            const delta = lastAssistantText && txt.startsWith(lastAssistantText) ? txt.slice(lastAssistantText.length) : txt;
            lastAssistantText = txt;
            answer = txt;
            answerSettledSince = 0; // new content → restart stability window
            if (delta && onDelta) onDelta("content", delta);
          }
        } else if (txt && (role === "assistant" || kind === "thinking" || kind === "tool" || kind === "status")) {
          const tag = kind === "tool" ? "[tool] " : kind === "status" ? "[status] " : "";
          const chunk = `${tag}${txt}\n`;
          reasoning += chunk;
          if (onDelta) onDelta("reasoning", chunk);
        }
      }
    } else if (mr && mr.status !== 200) {
      console.error("[hoplite] messages poll HTTP", mr.status, mr.text?.slice(0, 160));
    }

    const st = classifyThreadState(tr.json.thread);
    lastStateRaw = st.raw;
    if (st.kind === "failed") {
      return { ok: false, error: `hoplite run ${st.raw || "failed"}${answer ? ` | partial: ${answer.slice(0, 200)}` : ""}`, reasoning, threadId };
    }
    if (answer && !answerSettledSince) answerSettledSince = Date.now();
    else if (!answer) answerSettledSince = 0;
    if (answer && Date.now() - answerSettledSince > 30000) {
      return { ok: true, answer, reasoning, threadId, stateRaw: st.raw, earlyClose: true };
    }
    if (st.kind === "done") {
      if (!answer && lastAssistantText) answer = lastAssistantText;
      if (!answer) return { ok: false, error: `hoplite run ended (${st.raw}) with no assistant message`, reasoning, threadId };
      return { ok: true, answer, reasoning, threadId, stateRaw: st.raw };
    }
    if (st.kind === "unknown") console.log(`[hoplite] thread ${threadId} unknown status raw=${JSON.stringify(st.raw)}`);
    await sleep(CFG.pollMs);
  }
  return { ok: false, error: `run timeout after ${Math.round(CFG.runTimeoutMs / 1000)}s (last state: ${lastStateRaw || "?"})`, reasoning, threadId };
}

// ------------------------------------------------------------ completions --
function sseChunk(model, id, delta, finish = null) {
  return `data: ${JSON.stringify({
    id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function chunkText(str, size = 240) {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}

/**
 * Multi-key thread create/append. Keys are org-scoped (each has its own
 * projectId); rotation prefers keys whose org catalog has the requested model,
 * skips credit-exhausted keys, and fails over to the next key on
 * insufficient_credits / invalid-model / project errors.
 * Returns { keyIdx, threadId, userMsgId, fresh }.
 */
async function createOrReuseThread(messages, model, extraThreadOpts = {}) {
  const lastMsg = messages[messages.length - 1] || {};
  const userText = contentToText(lastMsg.content).trim() || "(empty message)";

  // Prefer keys whose org catalog actually has the model; keep config order otherwise.
  const order = CFG.keys.map((_, i) => i).filter(i => !creditsByKey[i].circuitOpen);
  const scored = [];
  for (const i of order) {
    const ids = catalogs[i].ids;
    scored.push({ i, hasModel: !ids || ids.includes(model) }); // unknown catalog → neutral-true
  }
  scored.sort((a, b) => (b.hasModel ? 1 : 0) - (a.hasModel ? 1 : 0));
  const keyOrder = scored.map(s => s.i);
  if (!keyOrder.length) {
    await refreshAllCredits(true);
    throw Object.assign(new Error("all hoplite keys exhausted (credits or revoked)"), { status: 507 });
  }

  const priorHash = priorSignature(messages);
  let lastErr = null;

  for (const keyIdx of keyOrder) {
    const apiKey = CFG.keys[keyIdx].apiKey;
    const key = cacheKey(keyIdx, model, priorHash);
    const cached = cacheGet(key);

    if (cached) {
      const cid = crypto.randomUUID();
      const r = await hopFetch("POST", `/api/threads/${cached}/messages`, {
        content: userText, clientMessageId: cid,
        metadata: model ? { model } : undefined,
      }, { apiKey });
      if (r.status === 201 && r.json?.ok) {
        const userMsgId = r.json?.message?.id || null;
        return { keyIdx, threadId: cached, userMsgId, fresh: false };
      }
      if (r.status === 402 || String(r.json?.error || "").includes("insufficient")) {
        creditsByKey[keyIdx].circuitOpen = true;
        logLine(`key[${keyIdx}] ${CFG.keys[keyIdx].name} exhausted mid-request → next key`);
        continue;
      }
      logLine(`append to cached thread failed: HTTP ${r.status} ${r.text?.slice(0, 150)} → recreating`);
    }

    // Fresh thread: full transcript as prompt. Idempotent retry on transport error.
    const prompt = `${flattenConversation(messages.slice(0, -1))}\n\n### User (latest)\n${userText}`.trim();
    const title = `[bridge] ${userText.replace(/\s+/g, " ").slice(0, 60)}`;
    const opId = crypto.randomUUID();
    let r = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        r = await hopFetch("POST", "/api/threads", {
          projectId: CFG.keys[keyIdx].projectId, prompt, title, model: model || undefined, clientOperationId: opId,
          ...(extraThreadOpts.speed ? { speed: extraThreadOpts.speed } : {}),
          ...(extraThreadOpts.reasoning ? { reasoning: extraThreadOpts.reasoning } : {}),
        }, { timeoutMs: 60000, apiKey });
        if (r.status === 201) break;
        const errText = String(r.json?.error || r.text || "").toLowerCase();
        if (errText.includes("insufficient")) break; // failover to next key, no retry on same key
        // sandbox_limit / capacity errors: backoff and retry (nikita4a lesson)
        if (r.status < 500 && !/sandbox|capacity|limit|retained|busy/.test(errText)) break; // non-retryable client error
        await sleep(4000 * (attempt + 1));
      } catch (e) {
        if (attempt === 3) { lastErr = new Error(`thread create transport failure: ${e.message}`); r = null; break; }
        await sleep(1500);
      }
    }
    if (r && r.status === 201 && r.json?.ok && r.json?.thread?.id) {
      const threadId = r.json.thread.id;
      cachePut(key, threadId);
      logLine(`key[${keyIdx}] ${CFG.keys[keyIdx].name} created thread ${threadId} (model=${model || "default"})`);
      const userMsgId = r.json?.message?.id || r.json?.initialMessageId || null;
      return { keyIdx, threadId, userMsgId, fresh: true };
    }
    if (r) {
      const errText = String(r.json?.error || "").toLowerCase();
      logLine(`key[${keyIdx}] ${CFG.keys[keyIdx].name} create failed: HTTP ${r.status} ${r.json?.error || r.text?.slice(0, 150)} → next key`);
      if (r.status === 402 || errText.includes("insufficient")) creditsByKey[keyIdx].circuitOpen = true;
      if (r.status === 401) creditsByKey[keyIdx].circuitOpen = true; // revoked
      lastErr = new Error(`thread create failed on ${CFG.keys[keyIdx].name}: HTTP ${r.status} ${r.json?.error || r.text?.slice(0, 120)}`);
      continue; // failover to next key
    }
  }
  throw lastErr || Object.assign(new Error("all hoplite keys failed"), { status: 502 });
}

async function handleChat(req, res, body) {
  stats.requests++;
  // Per-key circuit breakers: only 507 when EVERY key is exhausted/revoked.
  await refreshAllCredits();
  if (allKeysOpen()) {
    await refreshAllCredits(true);
    if (allKeysOpen()) {
      stats.errors++;
      return sendJson(res, 507, { error: { message: "all hoplite keys exhausted (credits or revoked). Top up or adjust keys/minCredits.", type: "insufficient_credits", credits: creditsSnapshot() } });
    }
  }
  const isStream = body.stream === true;
  let model = String(body.model || "");
  if (model.startsWith("hoplite/")) model = model.slice("hoplite/".length);
  const union = await listModels();
  if (!model || !union.includes(model)) {
    console.error(`[hoplite] model "${model}" not in any catalog → default ${CFG.defaultModel}`);
    model = CFG.defaultModel;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return sendJson(res, 400, { error: { message: "messages[] required", type: "invalid_request_error" } });
  const id = `chatcmpl-${crypto.randomUUID()}`;

  let t;
  try {
    await acquireRunSlot();
    t = await createOrReuseThread(messages, model, {
      speed: body.speed === "fast" ? "fast" : undefined,
      reasoning: body.reasoning_effort ? { mode: body.reasoning_effort } : undefined,
    });
  } catch (e) {
    stats.errors++;
    releaseRunSlot();
    return sendJson(res, e.status || 502, { error: { message: String(e.message || e), type: "upstream_error" } });
  }
  stats.runs++;

  if (!isStream) {
    const out = await driveRun(t.keyIdx, t.threadId, t.userMsgId, null).finally(releaseRunSlot);
    if (!out.ok) {
      stats.errors++;
      threads.delete(cacheKey(t.keyIdx, model, priorSignature(messages))); // dead thread → don't reuse
      return sendJson(res, 502, { error: { message: out.error, type: "upstream_error", hoplite_thread: out.threadId } });
    }
    stats.contentChars += out.answer.length;
    cachePut(continuationKey(t.keyIdx, model, messages, out.answer), out.threadId);
    return sendJson(res, 200, {
      id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: "assistant", content: out.answer }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      hoplite_key: CFG.keys[t.keyIdx].name,
    });
  }

  // Streaming: SSE with reasoning_content liveness + content chunks.
  res.writeHead(200, {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
    Connection: "keep-alive", "X-Accel-Buffering": "no",
  });
  res.write(sseChunk(model, id, { role: "assistant", content: "" }));
  let heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
  let closed = false;
  res.on("close", () => { closed = true; clearInterval(heartbeat); });

  const out = await driveRun(t.keyIdx, t.threadId, t.userMsgId, (type, text) => {
    if (closed) return;
    if (type === "reasoning") {
      for (const piece of chunkText(text)) res.write(sseChunk(model, id, { reasoning_content: piece }));
    } else {
      for (const piece of chunkText(text)) res.write(sseChunk(model, id, { content: piece }));
    }
  }).finally(releaseRunSlot);
  clearInterval(heartbeat);
  if (closed) return;
  if (!out.ok) {
    stats.errors++;
    // Mid-stream failure: real error chunk + stop. (Pre-content failures in the
    // non-stream path return 502 for 9router failover; here headers already sent.)
    res.write(sseChunk(model, id, { content: `\n\n[hoplite bridge error: ${out.error}]` }));
    res.write(sseChunk(model, id, {}, "stop"));
    res.write("data: [DONE]\n\n");
    return res.end();
  }
  stats.contentChars += out.answer.length;
  cachePut(continuationKey(t.keyIdx, model, messages, out.answer), out.threadId);
  res.write(sseChunk(model, id, {}, "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
}

// ------------------------------------------------------------------ server --
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      // Upstream probe: report degraded if Hoplite itself is unreachable.
      let upstream = { ok: false };
      try {
        const h = await hopFetch("GET", "/health", undefined, { timeoutMs: 5000 });
        upstream = { ok: h.status === 200 && h.json?.ok === true, version: h.json?.version };
      } catch (_) {}
      await refreshAllCredits();
      return sendJson(res, 200, { ok: true, service: "hoplite-bridge", defaultModel: CFG.defaultModel, keys: CFG.keys.map(k => k.name), upstream, credits: creditsSnapshot(), queueDepth: runQueue.length, activeRuns, threads: threads.size, stats });
    }
    if (req.method === "GET" && url.pathname === "/pool-status") {
      // 9Router serviceManager probe for category "Proxy" (tabbit convention).
      await refreshAllCredits();
      return sendJson(res, 200, { ok: true, status: "ready", defaultModel: CFG.defaultModel, credits: creditsSnapshot(), threads: threads.size, stats });
    }
    if (req.method === "GET" && url.pathname === "/credits") {
      await refreshAllCredits(true);
      return sendJson(res, 200, { ok: true, credits: creditsSnapshot() });
    }
    if (req.method === "GET" && url.pathname === "/usage") {
      return sendJson(res, 200, { requests: stats.requests, tokens: stats.contentChars, runs: stats.runs, errors: stats.errors, threads: threads.size });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const ids = await listModels();
      return sendJson(res, 200, { object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "hoplite" })) });
    }
    if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf-8")); }
      catch (_) { return sendJson(res, 400, { error: { message: "invalid JSON", type: "invalid_request_error" } }); }
      return await handleChat(req, res, body);
    }
    return sendJson(res, 404, { error: { message: `no route: ${req.method} ${url.pathname}` } });
  } catch (e) {
    stats.errors++;
    console.error("[hoplite] handler error:", e);
    try { sendJson(res, 500, { error: { message: String(e.message || e), type: "bridge_error" } }); } catch (_) {}
  }
});

server.listen(CFG.port, "127.0.0.1", () => {
  console.log(`[hoplite] bridge on http://127.0.0.1:${CFG.port} keys=[${CFG.keys.map(k => k.name).join(", ")}] defaultModel=${CFG.defaultModel}`);
});
