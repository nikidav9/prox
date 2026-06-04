import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { AGENTS } from "@/lib/agents";
import { saveHistory } from "@/lib/supabase";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

async function tgSend(chatId: string, text: string, threadId: number) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, message_thread_id: threadId }),
  }).then(r => r.json());
}

// GET /api/setup-topics — читает последние сообщения из Supabase,
// находит groupChatId и threadId для каждого агента, сохраняет конфиг и отправляет /setup
export async function GET() {
  if (!BOT_TOKEN) return NextResponse.json({ error: "no token" }, { status: 500 });

  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  const { data } = await sb.from("chat_histories").select("agent_id, messages");
  if (!data) return NextResponse.json({ error: "no data" });

  // Собираем groupId и topicMap из сохранённых сообщений
  const agentIds = AGENTS.map(a => a.id);
  const topicMap: Record<string, number> = {};
  let groupId = "";

  for (const row of data) {
    if (!agentIds.includes(row.agent_id)) continue;
    for (const msg of (row.messages ?? []).reverse()) {
      if (msg._groupChatId && msg._threadId) {
        groupId = String(msg._groupChatId);
        topicMap[row.agent_id] = Number(msg._threadId);
        break;
      }
    }
  }

  if (!groupId || Object.keys(topicMap).length === 0) {
    return NextResponse.json({
      error: "Не найдены groupChatId/threadId. Напиши что-нибудь в каждой теме группы и повтори.",
      found: { groupId, topicMap }
    });
  }

  // Сохраняем конфиг
  await saveHistory("_tg_group_config", [{ role: "system", text: JSON.stringify({ groupId, topicMap }) }]);

  // Отправляем /setup в каждую тему
  const results: Record<string, string> = {};
  for (const [agentId, threadId] of Object.entries(topicMap)) {
    const r = await tgSend(groupId, `/setup ${agentId}`, threadId);
    results[agentId] = r.ok ? "✅" : (r.description ?? "ошибка");
  }

  return NextResponse.json({ ok: true, groupId, topicMap, results });
}
