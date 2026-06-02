import { NextRequest, NextResponse } from "next/server";
import { loadAllHistories } from "@/lib/supabase";

const BASE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "https://prox-two-zeta.vercel.app";

// Called by Vercel Cron every minute
export async function GET(req: NextRequest) {
  // Verify it's from Vercel Cron
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const allHistories = await loadAllHistories();
  const dispatched: string[] = [];

  await Promise.all(
    Object.entries(allHistories).map(async ([agentId, msgs]) => {
      // Skip internal keys
      if (agentId.startsWith("_")) return;
      if (!msgs || msgs.length === 0) return;

      const last = msgs[msgs.length - 1];
      if (last?.role !== "user") return;

      // Dispatch to agent
      try {
        await fetch(`${BASE_URL}/api/agent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: last.text,
            agentId,
            history: [],
            githubToken: process.env.GITHUB_TOKEN || "",
          }),
        });
        dispatched.push(agentId);
      } catch {}
    })
  );

  return NextResponse.json({ ok: true, dispatched });
}
