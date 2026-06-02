import { NextRequest, NextResponse } from "next/server";
import { loadHistory, saveHistory } from "@/lib/supabase";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const BASE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "https://prox-two-zeta.vercel.app";

// Deduplicate webhook retries: Telegram retries if no 200 in 5s, but our agent takes longer.
// We respond 200 immediately and process async. Track recent update_ids to skip duplicates.
const recentUpdates = new Set<number>();

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const msg = body?.message;
    if (!msg) return NextResponse.json({ ok: true });

    // Skip duplicate webhook retries from Telegram
    const updateId: number = body?.update_id;
    if (updateId) {
      if (recentUpdates.has(updateId)) return NextResponse.json({ ok: true });
      recentUpdates.add(updateId);
      // Clean up old entries after 60 entries to avoid memory leak
      if (recentUpdates.size > 60) {
        const first = recentUpdates.values().next().value as number;
        recentUpdates.delete(first);
      }
    }

    const chatId = String(msg.chat?.id || "");
    const text: string = msg.text || "";
    if (!chatId || !text) return NextResponse.json({ ok: true });

    // Persist chat_id
    await saveHistory("_tg_config", [{ role: "system", text: chatId }]);

    if (text === "/start") {
      await sendTelegram(chatId, "Привет, Создатель 👋\nЛена будет писать сюда когда нужно твоё решение. Просто отвечай — она получит ответ и продолжит работу.");
      return NextResponse.json({ ok: true });
    }

    // Respond 200 to Telegram immediately to prevent retry, then process async.
    // agent/route.ts sends the reply to Telegram itself when agentId === "pm".
    void (async () => {
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, action: "typing" }),
        }).catch(() => {});

        await fetch(`${BASE_URL}/api/agent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, agentId: "pm", history: [] }),
        }).catch(() => null);
        // Note: agent/route.ts sends Telegram reply internally — no duplicate send here
      } catch (e) {
        console.error("[telegram webhook async]", e);
      }
    })();
  } catch (e) {
    console.error("[telegram webhook]", e);
  }
  return NextResponse.json({ ok: true });
}

export async function sendTelegram(chatId: string, text: string) {
  if (!BOT_TOKEN || !chatId) return;
  // Strip HTML tags, send as plain text to avoid parse failures
  const plain = text.replace(/<[^>]+>/g, "").trim();
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: plain }),
  }).catch((e) => console.error("[telegram] send error:", e));
}

export async function getTelegramChatId(): Promise<string> {
  const config = await loadHistory("_tg_config");
  return config[0]?.text || "";
}
