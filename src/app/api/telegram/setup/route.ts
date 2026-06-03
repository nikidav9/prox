import { NextRequest, NextResponse } from "next/server";
import { loadHistory, saveHistory } from "@/lib/supabase";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

const AGENTS = [
  { id: "pm",        name: "Lena",  role: "Менеджер",         icon: "🟡" },
  { id: "frontend",  name: "Alex",  role: "Фронтенд",         icon: "🔵" },
  { id: "backend",   name: "Sam",   role: "Бэкенд",           icon: "🟢" },
  { id: "designer",  name: "Mia",   role: "Дизайнер",         icon: "🩷" },
  { id: "devops",    name: "Max",   role: "DevOps",            icon: "🟠" },
  { id: "qa",        name: "Dan",   role: "Тестировщик",      icon: "🔴" },
  { id: "data",      name: "Nina",  role: "Аналитик данных",  icon: "🟣" },
  { id: "security",  name: "Kai",   role: "Безопасность",     icon: "⚪" },
  { id: "mobile",    name: "Rio",   role: "Мобильный",        icon: "🟩" },
  { id: "architect", name: "Leo",   role: "Архитектор",       icon: "⚫" },
  { id: "ml",        name: "Zoe",   role: "ML",               icon: "🔮" },
  { id: "web3",      name: "Rex",   role: "Web3",             icon: "🩵" },
  { id: "sre",       name: "Eva",   role: "SRE",              icon: "🌸" },
  { id: "writer",    name: "Noa",   role: "Тех. писатель",    icon: "💛" },
  { id: "scrum",     name: "Vik",   role: "Scrum-мастер",     icon: "🩵" },
];

async function tg(method: string, body: object) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// GET /api/telegram/setup — returns current config
export async function GET() {
  const config = await loadHistory("_tg_group_config");
  return NextResponse.json(config[0] || { error: "not configured" });
}

// POST /api/telegram/setup?groupId=-100xxx — creates all topics
export async function POST(req: NextRequest) {
  const groupId = req.nextUrl.searchParams.get("groupId");
  if (!groupId) return NextResponse.json({ error: "groupId required" }, { status: 400 });

  const topicMap: Record<string, number> = {};
  const results = [];

  for (const agent of AGENTS) {
    const topicName = `${agent.icon} ${agent.name} · ${agent.role}`;
    const res = await tg("createForumTopic", {
      chat_id: groupId,
      name: topicName,
    });
    if (res.ok) {
      const threadId = res.result.message_thread_id;
      topicMap[agent.id] = threadId;
      results.push({ agent: agent.id, topic: topicName, threadId });
      // Pin a welcome message in each topic
      await tg("sendMessage", {
        chat_id: groupId,
        message_thread_id: threadId,
        text: `${agent.icon} *${agent.name}* — ${agent.role}\n\nПишите сюда чтобы пообщаться с ${agent.name}.`,
        parse_mode: "Markdown",
      });
    } else {
      results.push({ agent: agent.id, error: res.description });
    }
    // Small delay to avoid Telegram rate limits
    await new Promise(r => setTimeout(r, 300));
  }

  // Save config to Supabase
  await saveHistory("_tg_group_config", [{
    role: "system",
    text: JSON.stringify({ groupId, topicMap }),
  }]);

  return NextResponse.json({ ok: true, groupId, topics: results });
}
