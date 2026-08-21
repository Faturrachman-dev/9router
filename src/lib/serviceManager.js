import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import net from "node:net";
import { join } from "node:path";

const HOMEDIR = process.env.USERPROFILE || homedir();
const CONFIG_FILE = join(HOMEDIR, "tools", "9router", "service_config.json");
// Machine-specific absolute paths hidden from @vercel/nft's asset tracer, which
// bundles any string literal that resolves to a real path on the build machine
// (pulls Tabbit/, Sandboxie-Plus/, C:/Tools/* into standalone → ENOENT mkdir on
// build + output bloat). A .join() call is opaque to the static analyzer.
const wp = (...seg) => seg.join("/");
const TABBIT_DIR = wp("C:", "FATUR", "DATA", "Projects", "AI APIs", "Tabbit");
const PORT_CHECK_TIMEOUT = 500;

// Reseed (Tabbit box re-harvest) wiring. Maps each service's CDP port to its
// Sandboxie box so the Reseed button can (re)launch a headful, logged-in box and
// let the proxy re-harvest a fresh token on restart.
const SANDBOXIE_START = wp("C:", "Program Files", "Sandboxie-Plus", "Start.exe");
const TABBIT_BROWSER = wp("C:", "FATUR", "Program Files", "Tabbit", "Application", "Tabbit Browser.exe");
const CDP_TO_BOX = { "9446": "Tabbit_Gmail1", "9447": "Tabbit_Gmail2", "9448": "Tabbit_Gmail3" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOG_RING = [];
const MAX_LOG = 200;

function addLog(svcId, msg, level = "info") {
  const entry = { ts: new Date().toISOString(), svc: svcId, msg, level };
  LOG_RING.push(entry);
  if (LOG_RING.length > MAX_LOG) LOG_RING.shift();
}

const DEFAULT_SERVICES = [
  {
    id: "tabbit-gmail1",
    name: "Tabbit Gmail1 :8001",
    category: "Proxy",
    port: 8001,
    cwd: join(TABBIT_DIR, "proxy"),
    cmd: ["pythonw", "proxy.py"],
    env: { PORT: "8001", TABBIT_CDP_PORTS: "9446" },
    enabled: true,
  },
  {
    id: "tabbit-gmail2",
    name: "Tabbit Gmail2 :8002",
    category: "Proxy",
    port: 8002,
    cwd: join(TABBIT_DIR, "proxy"),
    cmd: ["pythonw", "proxy.py"],
    env: { PORT: "8002", TABBIT_CDP_PORTS: "9447" },
    enabled: true,
  },
  {
    id: "tabbit-gmail3",
    name: "Tabbit Gmail3 :8003",
    category: "Proxy",
    port: 8003,
    cwd: join(TABBIT_DIR, "proxy"),
    cmd: ["pythonw", "proxy.py"],
    env: { PORT: "8003", TABBIT_CDP_PORTS: "9448" },
    enabled: true,
  },
  {
    id: "tabbit-pool",
    name: "Tabbit Pool :8000",
    category: "Proxy",
    port: 8000,
    cwd: join(TABBIT_DIR, "proxy"),
    cmd: ["pythonw", "proxy.py"],
    // Pooled round-robin across all three boxes. This is the provider baseUrl
    // (:8000) used by 9router's Tabbit "Tabbit Proxy" connection + Pi's tabbit
    // provider + the /models import. autostart so it survives restarts.
    env: { PORT: "8000", TABBIT_CDP_PORTS: "9446,9447,9448" },
    enabled: true,
    autostart: true,
  },
  {
    id: "morph-proxy",
    name: "Morph Proxy :8790",
    category: "Proxy",
    port: 8790,
    cwd: wp("C:", "Tools", "morph-proxy-py"),
    cmd: ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8790"],
    env: { PORT: "8790" },
    enabled: true,
    autostart: true,
  },
  {
    id: "accio-proxy",
    name: "Accio Proxy :4000",
    category: "Proxy",
    port: 4000,
    cwd: wp("C:", "Tools", "fingerprint-chromium"),
    // Start the SUPERVISOR in --once mode, not accio-proxy.py directly: it brings
    // up the headless controller (:47990) AND the proxy (:4000) then exits. Starting
    // accio-proxy.py alone left the proxy with no browser behind it (all 503s).
    // --once (not daemon) so Stop — which kills the :4000 owner — isn't fought by a
    // watchdog on :4099; the proxy's own internal 3s watchdog still heals the link.
    // ACCIO_HEADLESS=1 => no browser window flashing on start/restart.
    cmd: ["python", "accio-supervisor.py", "--once"],
    env: { PORT: "4000", ACCIO_HEADLESS: "1" },
    health: "/health",
    // Model the Test button sends to :4000 — accio serves ids WITH the accio/
    // prefix. The old hardcoded "tabbit/glm-5.2" doesn't exist here -> test failed.
    testModel: "accio/auto",
    enabled: true,
  },
  {
    id: "accio-proxy-2",
    name: "Accio Proxy cf2 :4001",
    category: "Proxy",
    port: 4001,
    cwd: wp("C:", "Tools", "fingerprint-chromium"),
    // 2nd Accio account (profile camoufox-2). Same supervisor, env-pinned to its
    // own controller (:47991) + proxy (:4001) so it runs alongside :4000 without
    // colliding or clobbering the shared controller port file. See accio-supervisor.py.
    cmd: ["python", "accio-supervisor.py", "--once"],
    env: {
      PORT: "4001", ACCIO_HEADLESS: "1",
      ACCIO_PROFILE: "camoufox-2", ACCIO_CTRL_PORT: "47991",
      ACCIO_PROXY_PORT: "4001", ACCIO_SUPERVISOR_PORT: "4098",
    },
    health: "/health",
    testModel: "accio/auto",
    enabled: true,
  },
];

function findNode() {
  const candidates = [
    join(HOMEDIR, "AppData/Roaming/fnm/aliases/default/node.exe"),
    join(process.env.PROGRAMFILES || "C:/Program Files/nodejs/node.exe"),
    join(process.env["PROGRAMFILES(X86)"] || "C:/Program Files (x86)/nodejs/node.exe"),
  ];
  for (const c of candidates) { if (existsSync(c)) return c; }
  return "node";
}

function findPython() {
  const candidates = [
    join(HOMEDIR, "AppData/Local/Programs/Python/Python314/pythonw.exe"),
    join(HOMEDIR, "AppData/Local/Programs/Python/Python313/pythonw.exe"),
    join(HOMEDIR, "AppData/Local/Programs/Python/Python312/pythonw.exe"),
    "pythonw",
    "python",
  ];
  for (const c of candidates) {
    if (c === "pythonw" || c === "python") return c;
    if (existsSync(c)) return c;
  }
  return "python";
}

function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      const defaultMap = Object.fromEntries(DEFAULT_SERVICES.map((s) => [s.id, { ...s }]));
      for (const s of saved) { if (defaultMap[s.id]) Object.assign(defaultMap[s.id], s); }
      return Object.values(defaultMap);
    }
  } catch (_) {}
  return DEFAULT_SERVICES.map((s) => ({ ...s }));
}

function saveConfig(services) {
  const clean = services.map(({ _pid, ...rest }) => ({ ...rest }));
  try { writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2)); } catch (_) {}
}

const locks = new Map();
function getLock(id) { if (!locks.has(id)) locks.set(id, Promise.resolve()); return locks.get(id); }
function setLock(id, p) { locks.set(id, p.catch(() => {})); }

function portIsOpen(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(PORT_CHECK_TIMEOUT);
    sock.on("connect", () => { sock.destroy(); resolve(true); });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
    sock.connect(port, "127.0.0.1");
  });
}

function pidIsAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function serviceStatus(svc) {
  const portOpen = await portIsOpen(svc.port);
  if (!portOpen) return "stopped";
  if (svc.category === "Proxy") {
    try {
      const res = await fetch(`http://127.0.0.1:${svc.port}/pool-status`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return "running";
      return "starting";
    } catch { return "starting"; }
  }
  return "running";
}

// Lock-free start body. Callers that already hold the service lock (e.g. reseed)
// invoke this directly; startService() wraps it with the lock.
async function _startInner(svc) {
    const currentStatus = await serviceStatus(svc);
    if (currentStatus === "running") { addLog(svc.id, "already running"); return [true, "already running"]; }

    const cmd = [...svc.cmd];
    if (cmd[0] === "node") cmd[0] = findNode();
    if (cmd[0] === "pythonw" || cmd[0] === "python") cmd[0] = findPython();

    const env = { ...process.env, ...(svc.env || {}), PYTHONUNBUFFERED: "1" };
    addLog(svc.id, `spawning: ${cmd[0]} ${cmd.slice(1).join(" ")} cwd=${svc.cwd} PORT=${env.PORT} CDP=${env.TABBIT_CDP_PORTS || "none"}`);

    try {
      const proc = spawn(cmd[0], cmd.slice(1), {
        cwd: svc.cwd, env, stdio: "ignore", windowsHide: true, detached: true,
      });
      proc.unref();
      svc._pid = proc.pid;
      addLog(svc.id, `spawned pid ${proc.pid}`);

      proc.on("exit", (code) => {
        addLog(svc.id, `process exited code=${code}`);
        svc._pid = null;
      });
      proc.on("error", (e) => addLog(svc.id, `spawn error: ${e.message}`, "error"));

      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const open = await portIsOpen(svc.port);
        if (i % 4 === 0) addLog(svc.id, `waiting for :${svc.port}... (${i * 0.3}s)`);
        if (open) {
          const healthOk = svc.category === "Proxy" ? (async () => { try { const r = await fetch(`http://127.0.0.1:${svc.port}${svc.health || "/pool-status"}`, { signal: AbortSignal.timeout(3000) }); return r.ok; } catch { return false; } })() : true;
          if (await healthOk) { addLog(svc.id, `:${svc.port} bound + health OK — ready`); return [true, `pid ${proc.pid}`]; }
          addLog(svc.id, `:${svc.port} port open but /health not ready yet`);
        }
      }
      addLog(svc.id, `port :${svc.port} not bound after 6s`, "error");
      return [false, "port not bound — check proxy logs"];
    } catch (e) {
      addLog(svc.id, `spawn exception: ${e.message}`, "error");
      return [false, e.message];
    }
}

async function startService(svc) {
  const lock = getLock(svc.id);
  const result = lock
    .then(() => _startInner(svc))
    .catch((e) => { addLog(svc.id, `start failed: ${e.message}`, "error"); return [false, e.message]; });
  setLock(svc.id, result);
  return result;
}

// Lock-free stop body (port-sweep kill). reseed calls this directly under the lock.
async function _stopInner(svc) {
    const currentStatus = await serviceStatus(svc);
    if (currentStatus === "stopped") { addLog(svc.id, "already stopped"); return [true, "already stopped"]; }

    addLog(svc.id, `stopping :${svc.port}...`);
    const killed = [];

    // Sweep: kill all processes owning this port (round-robin workers, children, etc)
    for (let pass = 0; pass < 3; pass++) {
      try {
        const stdio = execSync(
          `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${svc.port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Write-Output $_.OwningProcess; Stop-Process -Id $_.OwningProcess -Force }"`,
          { encoding: "utf8", timeout: 5000, windowsHide: true }
        );
        const pids = stdio.trim().split(/\s+/).filter(p => p && p !== "0" && !killed.includes(p));
        for (const p of pids) { killed.push(p); addLog(svc.id, `killed pid ${p}`); }
      } catch (e) {
        if (!e.message?.includes("Command failed")) addLog(svc.id, `kill pass ${pass}: ${e.message}`, "error");
      }
      if (!(await portIsOpen(svc.port))) break;
      await new Promise(r => setTimeout(r, 500));
    }
    svc._pid = null;

    if (killed.length) addLog(svc.id, `killed ${killed.length} processes`);
    else addLog(svc.id, "no listening processes found", "warning");

    // Wait for port to actually free
    await new Promise(r => setTimeout(r, 1500));
    for (let i = 0; i < 15; i++) {
      if (!(await portIsOpen(svc.port))) { addLog(svc.id, "port free — stopped"); return [true, "stopped"]; }
      await new Promise(r => setTimeout(r, 500));
    }
    addLog(svc.id, "port still listening after 9s — force", "warning");
    return [true, "force stopped (port may linger)"];
}

async function stopService(svc) {
  const lock = getLock(svc.id);
  const result = lock
    .then(() => _stopInner(svc))
    .catch((e) => { addLog(svc.id, `stop failed: ${e.message}`, "error"); return [false, e.message]; });
  setLock(svc.id, result);
  return result;
}

// ── Reseed: relaunch the box + restart the proxy so it re-harvests a fresh token ─
async function cdpUp(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

async function ensureBoxUp(svc) {
  const cdp = (svc.env?.TABBIT_CDP_PORTS || "").split(",")[0].trim();
  if (!cdp) return [false, "no CDP port on service"];
  if (await cdpUp(cdp)) { addLog(svc.id, `box CDP :${cdp} already up`); return [true, "box already up"]; }
  const box = CDP_TO_BOX[cdp];
  if (!box) return [false, `no Sandboxie box mapped for CDP ${cdp}`];
  if (!existsSync(SANDBOXIE_START)) return [false, "Sandboxie Start.exe not found"];
  // Launch gotcha: a box already running Tabbit WITHOUT the debug flag swallows the
  // new launch (attaches to the existing process) and the port never binds.
  // Terminate first for a clean CDP bind.
  addLog(svc.id, `reseed: terminating box ${box} for a clean CDP bind`);
  try { execSync(`"${SANDBOXIE_START}" /box:${box} /terminate`, { timeout: 10000, windowsHide: true }); } catch (_) {}
  await sleep(1500);
  addLog(svc.id, `reseed: launching box ${box} headful --remote-debugging-port=${cdp}`);
  try {
    spawn(SANDBOXIE_START, [`/box:${box}`, TABBIT_BROWSER, `--remote-debugging-port=${cdp}`],
      { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch (e) { return [false, `box launch failed: ${e.message}`]; }
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await cdpUp(cdp)) { addLog(svc.id, `reseed: box CDP :${cdp} up (${(i * 0.5).toFixed(1)}s)`); return [true, "box launched"]; }
  }
  return [false, `box CDP :${cdp} not reachable after 20s (not logged in?)`];
}

// Real end-to-end health: a cheap completion, not just a port bind. This is what
// would have caught the 401 immediately.
async function completionProbe(svc) {
  const model = svc.probeModel || "Claude-Haiku-4.5";
  try {
    const r = await fetch(`http://127.0.0.1:${svc.port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 5 }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.choices?.length) return { ok: true, detail: model };
    const err = j?.error?.message || j?.error?.details || JSON.stringify(j).slice(0, 140);
    return { ok: false, detail: `HTTP ${r.status} ${err}` };
  } catch (e) { return { ok: false, detail: e.message }; }
}

async function reseedService(svc) {
  const lock = getLock(svc.id);
  const result = lock.then(async () => {
    if (!svc.env?.TABBIT_CDP_PORTS) return [false, "reseed is only for Tabbit proxies"];
    addLog(svc.id, "reseed: start");
    const [boxOk, boxMsg] = await ensureBoxUp(svc);
    if (!boxOk) return [false, `reseed aborted: ${boxMsg}`];
    // A cold-launched box redirects through login before it settles on a fresh
    // session token; harvesting too early grabs the stale on-disk cookie -> a 401
    // probe. Give it a moment to settle before the first harvest.
    if (boxMsg === "box launched") { addLog(svc.id, "reseed: settling 5s for fresh session"); await sleep(5000); }
    // Restart proxy + REAL completion probe. Retry once on auth failure — covers
    // the residual race where the box was still settling on the first harvest.
    let probe;
    for (let attempt = 1; attempt <= 2; attempt++) {
      addLog(svc.id, `reseed: proxy restart to re-harvest (attempt ${attempt})`);
      await _stopInner(svc);
      const [startOk, startMsg] = await _startInner(svc);
      if (!startOk) return [false, `proxy restart failed: ${startMsg}`];
      probe = await completionProbe(svc);
      if (probe.ok) { addLog(svc.id, `reseed OK — probe passed (${probe.detail})`); return [true, `reseeded; probe OK (${probe.detail})`]; }
      addLog(svc.id, `reseed: probe failed (attempt ${attempt}): ${probe.detail}`, "warning");
      if (attempt < 2) await sleep(4000);
    }
    addLog(svc.id, `reseed: proxy up but probe still failing: ${probe.detail}`, "error");
    return [false, `proxy up but probe failed: ${probe.detail}`];
  }).catch((e) => { addLog(svc.id, `reseed failed: ${e.message}`, "error"); return [false, e.message]; });
  setLock(svc.id, result);
  return result;
}

async function fetchUsage(proxyPort) {
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/usage`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return await res.json();
  } catch (_) {}
  return null;
}

function decodeJwtExp(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    let payload = parts[1];
    payload += "=".repeat((4 - (payload.length % 4)) % 4);
    payload = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
    return decoded.exp ? new Date(decoded.exp * 1000) : null;
  } catch (_) { return null; }
}

function readCredCache() {
  const path = join(TABBIT_DIR, "proxy", ".cred_cache.json");
  try { if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8")); } catch (_) {}
  return {};
}

let services = loadConfig();

function getLogs(source, lines = 40) {
  const tail = LOG_RING.slice(-lines);
  if (source === "manager") return tail.map(e => `[${e.ts}] [${e.svc}] ${e.msg}`);
  return tail.map(e => `[${e.ts}] [${e.svc}] ${e.msg}`);
}

async function getStatusAll() {
  const results = [];
  for (const svc of services) {
    const status = await serviceStatus(svc);
    results.push({
      id: svc.id, name: svc.name, category: svc.category || "Other",
      port: svc.port, status, enabled: svc.enabled !== false,
      cdp: svc.env?.TABBIT_CDP_PORTS || "",
      testModel: svc.testModel || null,
    });
  }
  return { services: results, running: results.filter(s => s.enabled && s.status === "running").length, total: results.filter(s => s.enabled).length };
}

async function getUsageAll() {
  const creds = readCredCache();
  const proxyServices = services.filter(s => s.category === "Proxy");
  const usageMap = {};
  await Promise.allSettled(proxyServices.map(async (svc) => { usageMap[svc.id] = await fetchUsage(svc.port); }));

  const output = [];
  for (const svc of proxyServices) {
    const live = usageMap[svc.id];
    const info = { service_id: svc.id, service_name: svc.name, port: svc.port };
    if (live?.instances?.length > 0) {
      const inst = live.instances[0];
      info.has_token = inst.has_token ?? false;
      info.usage_pct = inst.usage_percentage;
      info.tier = inst.member_level || "";
      info.reset_hours = inst.remaining_reset_hours;
    }
    // accio-proxy reports remaining account credits scraped from the header.
    if (live && live.credits !== undefined && live.credits !== null) info.credits = live.credits;
    // The .cred_cache.json / CDP token state is TABBIT-specific. Only apply it to
    // services that actually declare TABBIT_CDP_PORTS — otherwise non-Tabbit proxies
    // (e.g. accio) falsely inherited Tabbit gmail1's token (the old "9446" default),
    // showing a bogus EXPIRED/UUID badge. accio auth is a browser cookie, not here.
    const isTabbit = !!svc.env?.TABBIT_CDP_PORTS;
    if (isTabbit && ((!info.has_token && info.has_token !== false) || creds)) {
      const cdpList = svc.env.TABBIT_CDP_PORTS.split(",");
      for (const cdpPort of cdpList) {
        const cred = creds[cdpPort.trim()];
        if (!cred?.token) continue;
        const exp = decodeJwtExp(cred.token);
        const now = new Date();
        if (exp && exp > now) {
          info.has_token = true;
          const secs = Math.floor((exp - now) / 1000);
          info.token_expires_in = `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
        } else if (!info.has_token) { info.has_token = false; info.token_expired = true; }
        if (cred.unique_uuid) info.has_uuid = true;
        break;
      }
    }
    output.push(info);
  }
  return { proxies: output };
}

async function doStartAll() {
  addLog("*", "Start All");
  const results = [];
  for (const svc of services) {
    if (svc.enabled !== false) results.push([svc.id, ...(await startService(svc))]);
  }
  return results;
}

// Boot autostart: only services flagged autostart:true (not every enabled one).
// Called once per process from initializeApp. startService is idempotent (skips
// when already running), so hot-reload re-invocation is safe.
async function autoStartServices() {
  const targets = services.filter((s) => s.enabled !== false && s.autostart === true);
  if (!targets.length) return [];
  addLog("*", `Autostart: ${targets.map((s) => s.id).join(", ")}`);
  const results = [];
  for (const svc of targets) results.push([svc.id, ...(await startService(svc))]);
  return results;
}

async function doStopAll() {
  addLog("*", "Stop All");
  for (const svc of services) await stopService(svc);
}

async function doAction(action, svcId) {
  const svc = services.find(s => s.id === svcId);
  if (!svc) return [false, "unknown service"];
  if (action === "start") return startService(svc);
  if (action === "stop") return stopService(svc);
  if (action === "reseed") return reseedService(svc);
  return [false, `unknown action: ${action}`];
}

export { getLogs, getStatusAll, getUsageAll, doStartAll, doStopAll, doAction, portIsOpen, autoStartServices };
