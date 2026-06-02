import { NextRequest, NextResponse } from "next/server";
import { loadHistory, saveHistory } from "@/lib/supabase";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const BASE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "https://prox-two-zeta.vercel.app";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const msg = body?.message;
    if (!msg) return NextResponse.json({ ok: true });

    const chatId = String(msg.chat?.id || "");
    const text: string = msg.text || "";
    if (!chatId || !text) return NextResponse.json({ ok: true });

    // Persist chat_id
    await saveHistory("_tg_config", [{ role: "system", text: chatId }]);

    if (text === "/start") {
      await sendTelegram(chatId, "Привет, Создатель 👋\nЛена будет писать сюда когда нужно твоё решение. Просто отвечай — она получит ответ и продолжит работу.");
      return NextResponse.json({ ok: true });
    }

    // Send typing indicator
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    }).catch(() => {});

    // Add user reply to Lena's history
    const existing = await loadHistory("pm");
    await saveHistory("pm", [...existing, { role: "user", text, ts: Date.now() }]);

    // Call Lena directly and get her response
    const agentRes = await fetch(`${BASE_URL}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, agentId: "pm", history: [], githubToken: "" }),
    }).catch(() => null);

    if (agentRes?.ok) {
      const data = await agentRes.json().catch(() => ({}));
      const reply: string = data.text || "";
      if (reply) {
        // Strip [TASK:...] markers from Telegram message — keep it clean
        const cleanReply = reply.replace(/\[TASK:[\w-]+:[^\]]+\]\s*/g, "").trim() || "Принято, работаю.";
        await sendTelegram(chatId, `💬 <b>Лена:</b>\n${cleanReply}`);
      }
    } else {
      await sendTelegram(chatId, "✅ Получила, отвечу в чате.");
    }
  } catch (e) {
    console.error("[telegram webhook]", e);
  }
  return NextResponse.json({ ok: true });
}

export async function sendTelegram(chatId: string, text: string) {
  if (!BOT_TOKEN || !chatId) return;
  // Telegram HTML: escape < > &
  const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/&lt;b&gt;/g, "<b>").replace(/&lt;\/b&gt;/g, "</b>"); // restore our <b> tags
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: safe, parse_mode: "HTML" }),
  }).catch(() => {});
}

export async function getTelegramChatId(): Promise<string> {
  const config = await loadHistory("_tg_config");
  return config[0]?.text || "";
}
