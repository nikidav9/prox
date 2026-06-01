import { NextResponse } from "next/server";
import { loadAllHistories } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET() {
  const histories = await loadAllHistories();
  return NextResponse.json(histories);
}
