import { NextResponse } from "next/server";
import { saveCooldowns } from "@/lib/supabase";

export async function POST() {
  await saveCooldowns({});
  return NextResponse.json({ ok: true, message: "Кулдауны сброшены" });
}
