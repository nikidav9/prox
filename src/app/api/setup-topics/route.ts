import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { AGENTS } from "@/lib/agents";
import { saveHistory, loadHistory } from "@/lib/supabase";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

async function tgSend(chatId: string, text: string, threadId: number) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, message_thread_id: threadId }),
  }).then(r => r.json());
}

export async function POST(req: NextRequest) {
  const { groupId, topicMap } = await req.json();
  if (!groupId || !topicMap) return NextResponse.json({ error: "groupId and topicMap required" }, { status: 400 });
  await saveHistory("_tg_group_config", [{ role: "system", text: JSON.stringify({ groupId, topicMap }) }]);
  return NextResponse.json({ ok: true, groupId, topicMap });
}

export async function GET() {
  if (!BOT_TOKEN) return NextResponse.json({ error: "no token" }, { status: 500 });

  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  const { data } = await sb.from("chat_histories").select("agent_id, messages");
  if (!data) return NextResponse.json({ error: "no data" });

  const agentIds = AGENTS.map(a => a.id);
  const topicMap: Record<string, number> = {};
  let groupId = "";

  // Источник 1: сообщения агентов (если конфиг уже был)
  for (const row of data) {
    if (!agentIds.includes(row.agent_id)) continue;
    for (const msg of [...(row.messages ?? [])].reverse()) {
      if (msg._groupChatId && msg._threadId) {
        groupId = String(msg._groupChatId);
        topicMap[row.agent_id] = Number(msg._threadId);
        break;
      }
    }
  }

  // Источник 2: _tg_pending (сообщения до настройки конфига)
  const pending = data.find(r => r.agent_id === "_tg_pending")?.messages ?? [];
  for (const msg of pending) {
    if (msg._groupChatId && msg._threadId) {
      groupId = groupId || String(msg._groupChatId);
      // Пытаемся сопоставить threadId с агентом по порядку тем
      // Сохраняем все уникальные threadId для ручной/авто привязки
      const tid = Number(msg._threadId);
      const alreadyMapped = Object.values(topicMap).includes(tid);
      if (!alreadyMapped) {
        // Временно сохраняем как unknown_<tid>
        topicMap[`_unknown_${tid}`] = tid;
      }
    }
  }

  if (!groupId) {
    return NextResponse.json({
      error: "Не найдены сообщения с groupChatId. Убедись что написал в темах группы.",
      pending: pending.length,
      agentData: data.filter(r => agentIds.includes(r.agent_id)).map(r => ({ id: r.agent_id, msgs: r.messages?.length }))
    });
  }

  // Сохраняем конфиг (только известные агенты)
  const cleanMap: Record<string, number> = {};
  for (const [k, v] of Object.entries(topicMap)) {
    if (!k.startsWith("_unknown_")) cleanMap[k] = v;
  }

  if (Object.keys(cleanMap).length > 0) {
    await saveHistory("_tg_group_config", [{ role: "system", text: JSON.stringify({ groupId, topicMap: cleanMap }) }]);
  }

  // Отправляем /setup в известные темы
  const results: Record<string, string> = {};
  for (const [agentId, threadId] of Object.entries(cleanMap)) {
    const r = await tgSend(groupId, `/setup ${agentId}`, threadId);
    results[agentId] = r.ok ? "✅" : (r.description ?? "ошибка");
  }

  // Показываем неизвестные темы
  const unknownThreads = Object.entries(topicMap)
    .filter(([k]) => k.startsWith("_unknown_"))
    .map(([, v]) => v);

  return NextResponse.json({
    ok: true,
    groupId,
    topicMap: cleanMap,
    unknownThreads,
    results,
    hint: unknownThreads.length > 0
      ? `Найдены темы без агента: ${unknownThreads.join(", ")}. Напиши /setup agentId вручную в каждой.`
      : undefined
  });
}
