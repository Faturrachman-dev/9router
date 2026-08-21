import { NextResponse } from "next/server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function POST(req) {
  try {
    const body = await req.json();
    const model = body.model || "tabbit/glm-5.2";
    const message = body.message || "hi";
    const port = body.port || null;

    const baseUrl = port ? `http://127.0.0.1:${port}/v1` : "http://127.0.0.1:20128/v1";
    const ctrl = new AbortController();
    // 60s: some backends (e.g. accio) have a ~20-35s cold-start on the first turn
    // after a (re)start; 15s aborted them mid-warmup ("This operation was aborted").
    setTimeout(() => ctrl.abort(), 60000);
    let res;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // stream:false — the proxy defaults to SSE streaming; res.json() below
        // cannot parse an event-stream, so force a plain JSON completion.
        body: JSON.stringify({ model, messages: [{ role: "user", content: message }], max_tokens: 20, stream: false }),
        signal: ctrl.signal,
      });
    } catch (fe) {
      const msg = fe.cause?.code === "ECONNREFUSED" ? `Port :${port} not listening — proxy may be stopped` : fe.message;
      return NextResponse.json({ ok: false, model, port, error: msg }, { status: 502, headers: CORS });
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || data.error?.message || "?";
    const ok = res.ok && !data.error;
    return NextResponse.json({ ok, model, port, content }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500, headers: CORS });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
