import { NextRequest, NextResponse } from "next/server";
import { AGENTS } from "@/lib/agents";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

async function tgSend(chatId: string, text: string, threadId: number) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, message_thread_id: threadId }),
  }).then(r => r.json());
}

// GET /api/setup-topics — показывает последние апдейты с thread_id для настройки
export async function GET() {
  if (!BOT_TOKEN) return NextResponse.json({ error: "no token" }, { status: 500 });
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?limit=100&allowed_updates=["message"]`);
  const data = await res.json();
  const topics: Record<string, { chatId: string; threadId: number; title: string }> = {};
  for (const u of data.result ?? []) {
    const msg = u.message;
    if (!msg?.message_thread_id) continue;
    const key = `${msg.chat.id}_${msg.message_thread_id}`;
    if (!topics[key]) {
      topics[key] = {
        chatId: String(msg.chat.id),
        threadId: msg.message_thread_id,
        title: msg.chat.title ?? "",
      };
    }
  }
  return NextResponse.json({ topics: Object.values(topics) });
}

// POST /api/setup-topics — отправляет /setup agentId в каждую тему
// Body: { groupId: "-100...", topicMap: { pm: 123, alex: 456, ... } }
export async function POST(req: NextRequest) {
  if (!BOT_TOKEN) return NextResponse.json({ error: "no token" }, { status: 500 });

  const { groupId, topicMap } = await req.json();
  if (!groupId || !topicMap) return NextResponse.json({ error: "groupId and topicMap required" }, { status: 400 });

  const results: Record<string, unknown> = {};
  for (const [agentId, threadId] of Object.entries(topicMap)) {
    const r = await tgSend(groupId, `/setup ${agentId}`, Number(threadId));
    results[agentId] = r.ok ? "✅" : r.description;
  }
  return NextResponse.json({ ok: true, results });
}
