import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";
import { AGENTS } from "@/lib/agents";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// Agents that participate in team discussions (skip architect who summarizes at end)
const TEAM_AGENTS = ["pm", "frontend", "backend", "devops", "qa"];

export async function POST(req: NextRequest) {
  try {
    const { topic } = await req.json();
    if (!topic) return NextResponse.json({ error: "topic required" }, { status: 400 });

    const messages: { agentId: string; agentName: string; role: string; text: string }[] = [];

    for (const agentId of TEAM_AGENTS) {
      const agent = AGENTS.find(a => a.id === agentId)!;
      const model = genAI.getGenerativeModel({
        model: "gemini-2.0-flash",
        systemInstruction: agent.soul + "\n\nТы участвуешь в командном обсуждении. Говори только на русском, кратко (2-4 предложения), без кода. Выражай своё мнение по теме с позиции своей роли. Обращайся к коллегам по имени если нужно.",
      });

      const prevContext = messages.length > 0
        ? "Предыдущие сообщения коллег:\n" + messages.map(m => `${m.agentName} (${m.role}): ${m.text}`).join("\n") + "\n\nТвой ответ:"
        : "Начни обсуждение:";

      const prompt = `Тема обсуждения: ${topic}\n\n${prevContext}`;
      const result = await model.generateContent(prompt);
      const text = result.response.text().trim();

      messages.push({ agentId, agentName: agent.name, role: agent.role, text });
    }

    // Architect summarizes
    const architect = AGENTS.find(a => a.id === "architect")!;
    const archModel = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: architect.soul + "\n\nГовори только на русском, без кода. Подведи итог обсуждения как архитектор.",
    });
    const archPrompt = `Тема: ${topic}\n\nОбсуждение команды:\n${messages.map(m => `${m.agentName}: ${m.text}`).join("\n")}\n\nПодведи итог и предложи план действий (3-5 предложений):`;
    const archResult = await archModel.generateContent(archPrompt);
    messages.push({ agentId: "architect", agentName: architect.name, role: architect.role, text: archResult.response.text().trim() });

    return NextResponse.json({ messages });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
