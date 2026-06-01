import { NextRequest, NextResponse } from "next/server";
import { loadAllHistories, clearHistory } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET() {
  const histories = await loadAllHistories();
  return NextResponse.json(histories);
}

export async function DELETE(req: NextRequest) {
  const { agentId } = await req.json();
  if (!agentId) return NextResponse.json({ error: "agentId required" }, { status: 400 });
  await clearHistory(agentId);
  return NextResponse.json({ ok: true });
}
