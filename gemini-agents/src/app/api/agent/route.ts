import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";
import { AGENTS } from "@/lib/agents";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export async function POST(req: NextRequest) {
  try {
    const { message, agentId, history } = await req.json();

    if (!message || !agentId) {
      return NextResponse.json({ error: "message and agentId required" }, { status: 400 });
    }

    const agent = AGENTS.find((a) => a.id === agentId);
    if (!agent) {
      return NextResponse.json({ error: "Unknown agent" }, { status: 400 });
    }

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
      systemInstruction: agent.soul,
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Agent error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
