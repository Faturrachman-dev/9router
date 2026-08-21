import { NextResponse } from "next/server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// Probes to verify routing chain works
const PROBES = [
  { name: "9Router", url: "http://127.0.0.1:20128/api/health", type: "json" },
  { name: "TabbitPool", url: "http://127.0.0.1:8000/pool-status", type: "json" },
];

export async function GET() {
  const results = [];
  for (const probe of PROBES) {
    const start = Date.now();
    try {
      const res = await fetch(probe.url, { signal: AbortSignal.timeout(5000) });
      results.push({
        name: probe.name,
        ok: res.ok,
        status: res.status,
        latency_ms: Date.now() - start,
      });
    } catch (e) {
      results.push({
        name: probe.name,
        ok: false,
        error: e.message,
        latency_ms: Date.now() - start,
      });
    }
  }
  const allOk = results.every((r) => r.ok);
  return NextResponse.json({ all_ok: allOk, probes: results }, {
    status: allOk ? 200 : 502,
    headers: CORS,
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
