"use client";

import { useState, useEffect, useCallback } from "react";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";

function colorForStatus(s) {
  if (s === "running") return "bg-green-500/20 text-green-400 border-green-500/30";
  if (s === "starting") return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
  return "bg-red-500/20 text-red-400 border-red-500/30";
}

function colorForPct(pct) {
  if (pct > 80) return "bg-red-500";
  if (pct > 50) return "bg-yellow-500";
  return "bg-green-500";
}

export default function ServicesPageClient() {
  const [services, setServices] = useState(null);
  const [usage, setUsage] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState({});

  const fetchData = useCallback(async () => {
    try {
      const [sr, ur] = await Promise.all([
        fetch("/api/v1/admin/services"),
        fetch("/api/v1/admin/services?type=usage"),
      ]);
      if (!sr.ok) throw new Error("status " + sr.status);
      const sd = await sr.json();
      setServices(sd.services);
      if (ur.ok) {
        const ud = await ur.json();
        const map = {};
        for (const p of ud.proxies) map[p.service_id] = p;
        setUsage(map);
      }
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const iv = setInterval(fetchData, 5000);
    return () => clearInterval(iv);
  }, [fetchData]);

  const doAction = async (act, svcId) => {
    if (busy[act + svcId]) return;
    setBusy((b) => ({ ...b, [act + svcId]: true }));
    try {
      await fetch("/api/v1/admin/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: act, service: svcId }),
      });
      setTimeout(fetchData, 800);
    } catch (_) {}
    finally { setBusy((b) => ({ ...b, [act + svcId]: false })); }
  };

  const testProxy = async (svc) => {
    const key = "test" + svc.id;
    if (busy[key]) return;
    setBusy((b) => ({ ...b, [key]: true, [key + "Result"]: null }));
    try {
      const res = await fetch("/api/v1/admin/proxy-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: svc.port, model: svc.testModel || "tabbit/glm-5.2", message: "say hello in one word" }),
      });
      const d = await res.json();
      setBusy((b) => ({ ...b, [key + "Result"]: d }));
    } catch (_) {
      setBusy((b) => ({ ...b, [key + "Result"]: { ok: false, error: "network" } }));
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  };

  if (loading) return <div className="p-6 text-sm text-muted">Loading services...</div>;
  if (error) return <div className="p-6"><Badge color="red">Error: {error}</Badge></div>;

  const cats = {};
  for (const svc of services) (cats[svc.category] = cats[svc.category] || []).push(svc);
  const running = services.filter((s) => s.enabled && s.status === "running").length;
  const total = services.filter((s) => s.enabled).length;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-fg">Services</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">{running}/{total} active</span>
          <span className={`w-2 h-2 rounded-full ${running === total ? "bg-green-500" : running > 0 ? "bg-yellow-500" : "bg-red-500"}`} />
        </div>
      </div>

      <div className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={fetchData} className="text-muted hover:text-fg border border-border">Refresh</Button>
        <Button size="sm" onClick={() => doAction("start-all")} disabled={busy["start-all"]}>
          Start All
        </Button>
        <Button size="sm" variant="danger" onClick={() => doAction("stop-all")} disabled={busy["stop-all"]}>
          Stop All
        </Button>
      </div>

      {Object.entries(cats).map(([cat, svcs]) => (
        <div key={cat}>
          <h3 className="text-xs font-semibold text-cyan mb-2 uppercase tracking-wider">{cat}</h3>
          <div className="space-y-2">
            {svcs.map((svc) => {
              const u = usage[svc.id] || {};
              const pct = u.usage_pct ? parseFloat(u.usage_pct) : null;
              const barCls = pct !== null ? colorForPct(pct) : "bg-muted";
              return (
                <Card key={svc.id} className="!p-3">
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full border ${svc.status === "running" ? "bg-green-500 border-green-500 shadow-[0_0_6px_rgba(34,197,94,.4)]" : svc.status === "starting" ? "border-yellow-500 animate-pulse" : "border-red-500"}`} />
                    <span className="flex-1 text-sm truncate font-mono">{svc.name}</span>
                    <span className="text-xs text-muted font-mono">{svc.cdp ? `CDP ${svc.cdp}` : ""}</span>
                    <Badge className={colorForStatus(svc.status)}>{svc.status.toUpperCase()}</Badge>
                    <Button size="xs" onClick={() => doAction("start", svc.id)} disabled={busy["start" + svc.id]}>Start</Button>
                    <Button size="xs" variant="danger" onClick={() => doAction("stop", svc.id)} disabled={busy["stop" + svc.id]}>Stop</Button>
                    {svc.category === "Proxy" && svc.status === "running" && (
                      <Button size="xs" variant="ghost" onClick={() => testProxy(svc)} disabled={busy["test" + svc.id]} className="text-cyan border border-cyan/30 hover:bg-cyan/10">
                        {busy["test" + svc.id] ? "..." : "Test"}
                      </Button>
                    )}
                    {svc.cdp && (
                      <Button size="xs" variant="ghost" onClick={() => doAction("reseed", svc.id)} disabled={busy["reseed" + svc.id]} title="Relaunch box + restart proxy + re-harvest token" className="text-amber-400 border border-amber-400/30 hover:bg-amber-400/10">
                        {busy["reseed" + svc.id] ? "reseeding..." : "Reseed"}
                      </Button>
                    )}
                  </div>
                  {pct !== null && (
                    <div className="mt-2 space-y-1">
                      <div className="flex gap-3 text-xs text-muted font-mono">
                        <span>USE {pct.toFixed(1)}%</span>
                        {u.tier && <span>LVL {u.tier.toUpperCase()}</span>}
                        {u.reset_hours && <span>RST {u.reset_hours}H</span>}
                        {u.has_token ? <span className="text-green-400">KEY</span> : <span className="text-red-400">NOKEY</span>}
                        {u.token_expires_in && <span>EXP {u.token_expires_in}</span>}
                      </div>
                      <div className="h-2 bg-surface border border-border rounded overflow-hidden">
                        <div className={`h-full transition-all duration-500 ${barCls}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )}
                  {pct === null && (u.has_token !== undefined || u.token_expires_in || u.credits !== undefined) && svc.category === "Proxy" && (
                    <div className="mt-2 text-xs text-muted font-mono">
                      {u.has_token !== undefined && (
                        <span className={u.has_token ? "text-green-400" : "text-red-400"}>
                          {u.has_token ? "KEY" : u.token_expired ? "EXPIRED" : "NOKEY"}
                        </span>
                      )}
                      {u.token_expires_in && <span className="ml-3">EXP {u.token_expires_in}</span>}
                      {u.has_uuid && <span className="ml-3 text-green-400">UUID</span>}
                      {u.credits !== undefined && (
                        <span className={`ml-3 ${u.credits > 50 ? "text-green-400" : u.credits > 0 ? "text-yellow-400" : "text-red-400"}`}>
                          CR {u.credits}
                        </span>
                      )}
                    </div>
                  )}
                  {busy["test" + svc.id + "Result"] && (
                    <div className={`mt-2 p-2 rounded text-xs font-mono border ${busy["test" + svc.id + "Result"].ok ? "bg-green-500/10 border-green-500/30 text-green-400" : "bg-red-500/10 border-red-500/30 text-red-400"}`}>
                      {busy["test" + svc.id + "Result"].ok
                        ? `✓ ${busy["test" + svc.id + "Result"].content}`
                        : `✗ ${busy["test" + svc.id + "Result"].error || "failed"}`
                      }
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </div>
      ))}

      <LogViewer />
    </div>
  );
}

function LogViewer() {
  const [logs, setLogs] = useState([]);
  const [source, setSource] = useState("manager");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const fetchLogs = async () => {
      try {
        const res = await fetch(`/api/v1/admin/logs?source=${source}&lines=40`);
        if (res.ok) {
          const d = await res.json();
          setLogs(d.lines || []);
        }
      } catch (_) {}
    };
    fetchLogs();
    const iv = setInterval(fetchLogs, 5000);
    return () => clearInterval(iv);
  }, [source, expanded]);

  return (
    <div className="mt-6 border-t border-border pt-4">
      <div className="flex items-center gap-3 mb-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs font-semibold text-muted hover:text-fg flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-sm">{expanded ? "expand_more" : "chevron_right"}</span>
          Logs
        </button>
        {expanded && (
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="text-xs bg-surface border border-border rounded px-2 py-0.5 text-muted"
          >
            <option value="manager">manager</option>
            <option value="proxy">proxy</option>
            <option value="router">router</option>
          </select>
        )}
        {expanded && <span className="text-xs text-muted">{logs.length} lines</span>}
      </div>
      {expanded && (
        <div className="bg-black/50 border border-border rounded p-3 max-h-64 overflow-y-auto font-mono text-xs leading-relaxed">
          {logs.length === 0 ? (
            <span className="text-muted">No log data</span>
          ) : (
            logs.map((line, i) => (
              <div key={i} className="text-muted hover:text-fg whitespace-pre-wrap break-all">
                {line}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
