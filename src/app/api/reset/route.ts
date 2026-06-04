import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_KEY!;
  if (!url || !key) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });

  const sb = createClient(url, key);
  const { error } = await sb.from("chat_histories").delete().neq("agent_id", "__never__");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, message: "Все истории чатов очищены" });
}
