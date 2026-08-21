import { NextResponse } from "next/server";
import { loadFullBodyWithFallback } from "@/lib/db/repos/requestDetailsRepo";

export async function GET(_req, { params }) {
  try {
    const { id } = await params;
    const result = await loadFullBodyWithFallback(id);
    if (!result) {
      return NextResponse.json({ error: "Body not found (no disk cache and no SQLite row for this id)" }, { status: 404 });
    }
    // For old requests (sqlite-preview source), the data may be a truncated {_truncated,_preview} object.
    return NextResponse.json({ data: result.data, source: result.source });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
