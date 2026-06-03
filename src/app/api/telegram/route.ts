import { NextRequest, NextResponse } from "next/server";
import { loadHistory, saveHistory, ChatMsg } from "@/lib/supabase";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const BASE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "https://prox-agents.vercel.app";

// Deduplicate Telegram webhook retries by update_id (in-memory, per instance)
const recentUpdates = new Set<number>();

// Cache group config in-memory (refreshed every 5 min)
let groupConfigCache: { groupId: string; topicMap: Record<string, number> } | null = null;
let groupConfigLoadedAt = 0;

async function getGroupConfig() {
  if (groupConfigCache && Date.now() - groupConfigLoadedAt < 5 * 60_000) return groupConfigCache;
  const config = await loadHistory("_tg_group_config");
  if (config[0]?.text) {
    try {
      groupConfigCache = JSON.parse(config[0].text);
      groupConfigLoadedAt = Date.now();
    } catch {}
  }
  return groupConfigCache;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const msg = body?.message;
    if (!msg) return NextResponse.json({ ok: true });

    // Deduplicate webhook retries
    const updateId: number = body?.update_id;
    if (updateId) {
      if (recentUpdates.has(updateId)) return NextResponse.json({ ok: true });
      recentUpdates.add(updateId);
      if (recentUpdates.size > 100) {
        const first = recentUpdates.values().next().value as number;
        recentUpdates.delete(first);
      }
    }

    const chatId = String(msg.chat?.id || "");
    const text: string = msg.text || "";
    const threadId: number | undefined = msg.message_thread_id;
    const chatType: string = msg.chat?.type || "private";

    if (!chatId || !text) return NextResponse.json({ ok: true });

    // ── GROUP MESSAGE with topic thread ──────────────────────────────────
    if ((chatType === "supergroup" || chatType === "group") && threadId) {
      const config = await getGroupConfig();
      if (!config) return NextResponse.json({ ok: true });

      const agentId = Object.entries(config.topicMap).find(([, tid]) => tid === threadId)?.[0];
      if (!agentId || text.startsWith("/")) return NextResponse.json({ ok: true });

      // Save message to Supabase with group metadata — Railway worker will pick it up
      const stored = await loadHistory(agentId);
      const lastMsg = stored[stored.length - 1];
      const isDup = lastMsg?.role === "user" && lastMsg?.text === text;
      if (!isDup) {
        const userMsg: ChatMsg = { role: "user", text, ts: Date.now(), _groupChatId: chatId, _threadId: threadId };
        await saveHistory(agentId, [...stored, userMsg]);
      }

      // Typing indicator (fire-and-forget)
      fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action: "typing", message_thread_id: threadId }),
      }).catch(() => {});

      // Return 200 immediately — Railway worker processes async
      return NextResponse.json({ ok: true });
    }

    // ── PRIVATE DM — only for the owner (existing flow for Lena/pm) ──────
    if (chatType === "private") {
      await saveHistory("_tg_config", [{ role: "system", text: chatId }]);

      if (text === "/start") {
        await sendTelegram(chatId, "Привет, Создатель 👋\nЛена будет писать сюда когда нужно твоё решение. Просто отвечай — она получит ответ и продолжит работу.");
        return NextResponse.json({ ok: true });
      }

      fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action: "typing" }),
      }).catch(() => {});

      await fetch(`${BASE_URL}/api/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, agentId: "pm", history: [] }),
      }).catch(() => null);
    }

  } catch (e) {
    console.error("[telegram webhook]", e);
  }
  return NextResponse.json({ ok: true });
}

export async function sendTelegram(chatId: string, text: string, threadId?: number) {
  if (!BOT_TOKEN || !chatId) return;
  const plain = text.replace(/<[^>]+>/g, "").trim();
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: plain,
      ...(threadId ? { message_thread_id: threadId } : {}),
    }),
  }).catch((e) => console.error("[telegram] send error:", e));
}

export async function getTelegramChatId(): Promise<string> {
  const config = await loadHistory("_tg_config");
  return config[0]?.text || "";
}

export async function getGroupInfo(): Promise<{ groupId: string; topicMap: Record<string, number> } | null> {
  return getGroupConfig();
}
