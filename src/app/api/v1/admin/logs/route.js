import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getLogs } from "@/lib/serviceManager";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const LOG_PATHS = {
  proxy: "C:/FATUR/DATA/Projects/AI APIs/Tabbit/proxy/proxy.log",
  router: "C:/Users/hafiz/tools/9router/server.log",
};

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const source = searchParams.get("source") || "manager";
  const lines = parseInt(searchParams.get("lines") || "50");

  try {
    if (source === "manager") {
      const logLines = getLogs("manager", lines);
      return NextResponse.json({ source: "manager", lines: logLines, total: logLines.length }, { headers: CORS });
    }
    const filepath = LOG_PATHS[source];
    if (!filepath || !existsSync(filepath)) {
      return NextResponse.json({ source, lines: [], error: "Log file not found" }, { headers: CORS });
    }
    const content = readFileSync(filepath, "utf-8");
    const allLines = content.split("\n").filter(Boolean);
    const tail = allLines.slice(-lines);
    return NextResponse.json({ source, path: filepath, total: allLines.length, lines: tail }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ source, lines: [], error: e.message }, { status: 500, headers: CORS });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
