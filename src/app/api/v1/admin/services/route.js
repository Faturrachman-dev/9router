import { NextResponse } from "next/server";
import { getStatusAll, getUsageAll, doStartAll, doStopAll, doAction } from "@/lib/serviceManager";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const type = searchParams.get("type") || "status";
    if (type === "usage") {
      const data = await getUsageAll();
      return NextResponse.json(data, { headers: CORS });
    }
    const data = await getStatusAll();
    return NextResponse.json(data, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ error: e.message, services: [], running: 0, total: 0 }, { status: 500, headers: CORS });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { action, service: svcId } = body;

    if (action === "start-all") {
      const results = await doStartAll();
      return NextResponse.json({ ok: true, results: results.map(([id, ok, msg]) => [id, ok, msg]) }, { headers: CORS });
    }
    if (action === "stop-all") {
      await doStopAll();
      return NextResponse.json({ ok: true }, { headers: CORS });
    }
    if (action === "start" || action === "stop" || action === "reseed") {
      if (!svcId) return NextResponse.json({ ok: false, error: "missing service" }, { status: 400, headers: CORS });
      const [ok, msg] = await doAction(action, svcId);
      return NextResponse.json({ ok, message: msg }, { headers: CORS });
    }
    return NextResponse.json({ ok: false, error: `unknown action: ${action}` }, { status: 400, headers: CORS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500, headers: CORS });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
