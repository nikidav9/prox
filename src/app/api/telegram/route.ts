import { NextRequest, NextResponse } from "next/server";
import { loadHistory, saveHistory } from "@/lib/supabase";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const msg = body?.message;
    if (!msg) return NextResponse.json({ ok: true });

    const chatId = String(msg.chat?.id || "");
    const text: string = msg.text || "";
    if (!chatId || !text) return NextResponse.json({ ok: true });

    // Persist chat_id so Lena can send messages back
    await saveHistory("_tg_config", [{ role: "system", text: chatId }]);

    if (text === "/start") {
      await sendTelegram(chatId, "Привет, Создатель 👋 Лена будет писать сюда когда понадобится твоё решение.");
      return NextResponse.json({ ok: true });
    }

    // Route reply into Lena's chat as user message
    const existing = await loadHistory("pm");
    await saveHistory("pm", [...existing, { role: "user", text, ts: Date.now() }]);

    await sendTelegram(chatId, "✅ Твой ответ передан Лене.");
  } catch {}
  return NextResponse.json({ ok: true });
}

export async function sendTelegram(chatId: string, text: string) {
  if (!BOT_TOKEN || !chatId) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  }).catch(() => {});
}

export async function getTelegramChatId(): Promise<string> {
  const config = await loadHistory("_tg_config");
  return config[0]?.text || "";
}
