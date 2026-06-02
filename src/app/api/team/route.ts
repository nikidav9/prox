import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";
import { NextRequest, NextResponse } from "next/server";
import { AGENTS } from "@/lib/agents";

export const maxDuration = 60;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

const TEAM_AGENTS = ["pm", "frontend", "backend", "devops", "qa"];

async function generateOne(systemPrompt: string, userPrompt: string): Promise<string> {
  // Gemini 2.0 flash
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash", systemInstruction: systemPrompt });
    const result = await Promise.race([
      model.generateContent(userPrompt),
      new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 12_000)),
    ]);
    return (result as Awaited<ReturnType<typeof model.generateContent>>).response.text().trim();
  } catch { /* fall through */ }

  // Gemini 1.5 flash
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", systemInstruction: systemPrompt });
    const result = await Promise.race([
      model.generateContent(userPrompt),
      new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 12_000)),
    ]);
    return (result as Awaited<ReturnType<typeof model.generateContent>>).response.text().trim();
  } catch { /* fall through */ }

  // Groq
  if (groq) {
    for (const model of ["llama-3.3-70b-versatile", "gemma2-9b-it", "llama-3.1-8b-instant"]) {
      try {
        const res = await Promise.race([
          groq.chat.completions.create({
            model, stream: false,
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
            max_tokens: 200,
          }),
          new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 10_000)),
        ]) as { choices: { message: { content: string } }[] };
        const text = res.choices[0]?.message?.content || "";
        if (text) return text.trim();
      } catch { /* try next */ }
    }
  }

  // OpenRouter
  if (process.env.OPENROUTER_API_KEY) {
    for (const model of ["openai/gpt-oss-120b:free", "google/gemma-4-31b-it:free"]) {
      try {
        const res = await Promise.race([
          fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://gemini-agents-mocha.vercel.app",
              "X-Title": "Dev Office",
            },
            body: JSON.stringify({
              model, max_tokens: 200,
              messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
            }),
          }),
          new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 20_000)),
        ]);
        const data = await (res as Response).json() as { choices?: { message: { content: string } }[]; error?: { message: string } };
        if (data.error) continue;
        const text = data.choices?.[0]?.message?.content || "";
        if (text) return text.trim();
      } catch { /* try next */ }
    }
  }

  return "Нет ответа (все модели недоступны)";
}

export async function POST(req: NextRequest) {
  try {
    const { topic } = await req.json();
    if (!topic) return NextResponse.json({ error: "topic required" }, { status: 400 });

    // Run all team agents in parallel for speed (fits within 60s Vercel limit)
    const teamPromises = TEAM_AGENTS.map(agentId => {
      const agent = AGENTS.find(a => a.id === agentId)!;
      const systemPrompt = agent.soul + "\n\nТы участвуешь в командном обсуждении. Говори только на русском, кратко (2-4 предложения), без кода. Выражай своё мнение по теме с позиции своей роли.";
      const userPrompt = `Тема обсуждения: ${topic}\n\nВырази своё мнение как ${agent.role}:`;
      return generateOne(systemPrompt, userPrompt).then(text => ({
        agentId, agentName: agent.name, role: agent.role, text,
      }));
    });

    const messages = await Promise.all(teamPromises);

    // Architect summarizes
    const architect = AGENTS.find(a => a.id === "architect")!;
    const archSystem = architect.soul + "\n\nГовори только на русском, без кода. Подведи итог обсуждения как архитектор.";
    const archPrompt = `Тема: ${topic}\n\nМнения команды:\n${messages.map(m => `${m.agentName} (${m.role}): ${m.text}`).join("\n")}\n\nПодведи итог и предложи конкретный план действий (3-5 предложений):`;
    const archText = await generateOne(archSystem, archPrompt);
    messages.push({ agentId: "architect", agentName: architect.name, role: architect.role, text: archText });

    return NextResponse.json({ messages });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
