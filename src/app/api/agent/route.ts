import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const AGENTS = {
  researcher: {
    name: "Исследователь",
    systemPrompt:
      "Ты агент-исследователь. Анализируй вопросы глубоко, ищи факты, давай структурированные ответы с источниками знаний. Отвечай на языке пользователя.",
  },
  writer: {
    name: "Писатель",
    systemPrompt:
      "Ты агент-писатель. Создавай качественные тексты: статьи, посты, описания, письма. Учитывай стиль и аудиторию. Отвечай на языке пользователя.",
  },
  coder: {
    name: "Программист",
    systemPrompt:
      "Ты агент-программист. Пиши чистый код, объясняй решения, находи баги. Используй лучшие практики. Отвечай на языке пользователя.",
  },
  analyst: {
    name: "Аналитик",
    systemPrompt:
      "Ты агент-аналитик. Анализируй данные, выявляй паттерны, делай выводы и давай рекомендации. Отвечай на языке пользователя.",
  },
};

export type AgentId = keyof typeof AGENTS;

export async function POST(req: NextRequest) {
  try {
    const { message, agentId, history } = await req.json();

    if (!message || !agentId) {
      return NextResponse.json({ error: "message and agentId required" }, { status: 400 });
    }

    const agent = AGENTS[agentId as AgentId];
    if (!agent) {
      return NextResponse.json({ error: "Unknown agent" }, { status: 400 });
    }

    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: agent.systemPrompt,
    });

    const chat = model.startChat({
      history: (history || []).map((msg: { role: string; text: string }) => ({
        role: msg.role,
        parts: [{ text: msg.text }],
      })),
    });

    const result = await chat.sendMessage(message);
    const text = result.response.text();

    return NextResponse.json({ text, agentName: agent.name });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Agent error" }, { status: 500 });
  }
}
