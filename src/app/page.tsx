"use client";

import { useState, useRef, useEffect } from "react";

const AGENTS = [
  { id: "researcher", name: "Исследователь", icon: "🔍", desc: "Факты и анализ" },
  { id: "writer", name: "Писатель", icon: "✍️", desc: "Тексты и контент" },
  { id: "coder", name: "Программист", icon: "💻", desc: "Код и технологии" },
  { id: "analyst", name: "Аналитик", icon: "📊", desc: "Данные и выводы" },
];

type Message = { role: "user" | "model"; text: string };
type Histories = Record<string, Message[]>;

export default function Home() {
  const [activeAgent, setActiveAgent] = useState("researcher");
  const [histories, setHistories] = useState<Histories>({});
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const current = AGENTS.find((a) => a.id === activeAgent)!;
  const messages = histories[activeAgent] || [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function send() {
    if (!input.trim() || loading) return;
    const userText = input.trim();
    setInput("");

    const history = histories[activeAgent] || [];
    const updated = [...history, { role: "user" as const, text: userText }];
    setHistories((h) => ({ ...h, [activeAgent]: updated }));
    setLoading(true);

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userText, agentId: activeAgent, history }),
      });
      const data = await res.json();
      if (data.text) {
        setHistories((h) => ({
          ...h,
          [activeAgent]: [...updated, { role: "model", text: data.text }],
        }));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-screen bg-gray-950 text-white">
      <aside className="w-64 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="p-5 border-b border-gray-800">
          <h1 className="text-xl font-bold">Gemini Agents</h1>
          <p className="text-xs text-gray-400 mt-1">Выбери агента для работы</p>
        </div>
        <nav className="p-3 flex-1 space-y-1">
          {AGENTS.map((agent) => (
            <button
              key={agent.id}
              onClick={() => setActiveAgent(agent.id)}
              className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg text-left transition-colors ${
                activeAgent === agent.id
                  ? "bg-gray-700 text-white"
                  : "text-gray-400 hover:bg-gray-800 hover:text-white"
              }`}
            >
              <span className="text-2xl">{agent.icon}</span>
              <div>
                <div className="font-medium text-sm">{agent.name}</div>
                <div className="text-xs text-gray-500">{agent.desc}</div>
              </div>
              {(histories[agent.id]?.length || 0) > 0 && (
                <span className="ml-auto text-xs bg-gray-600 rounded-full px-2 py-0.5">
                  {Math.floor((histories[agent.id]?.length || 0) / 2)}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="p-4 border-t border-gray-800">
          <button
            onClick={() => setHistories((h) => ({ ...h, [activeAgent]: [] }))}
            className="w-full text-xs text-gray-500 hover:text-red-400 transition-colors"
          >
            Очистить чат
          </button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col">
        <header className="px-6 py-4 border-b border-gray-800 flex items-center gap-3">
          <span className="text-3xl">{current.icon}</span>
          <div>
            <h2 className="font-semibold">{current.name}</h2>
            <p className="text-xs text-gray-400">{current.desc}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
            <span className="text-xs text-gray-400">gemini-1.5-flash</span>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center text-gray-500">
              <span className="text-6xl mb-4">{current.icon}</span>
              <p className="text-lg font-medium text-gray-400">{current.name} готов</p>
              <p className="text-sm mt-1">{current.desc}</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              {msg.role === "model" && (
                <span className="text-xl mr-2 mt-1 flex-shrink-0">{current.icon}</span>
              )}
              <div
                className={`max-w-[70%] px-4 py-3 rounded-2xl text-sm whitespace-pre-wrap leading-relaxed ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white rounded-tr-sm"
                    : "bg-gray-800 text-gray-100 rounded-tl-sm"
                }`}
              >
                {msg.text}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <span className="text-xl mr-2">{current.icon}</span>
              <div className="bg-gray-800 px-4 py-3 rounded-2xl rounded-tl-sm">
                <div className="flex gap-1">
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="px-6 py-4 border-t border-gray-800">
          <div className="flex gap-3 items-end">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={`Спроси ${current.name.toLowerCase()}а...`}
              rows={1}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm resize-none focus:outline-none focus:border-gray-500 placeholder-gray-500"
              style={{ maxHeight: "120px" }}
            />
            <button
              onClick={send}
              disabled={loading || !input.trim()}
              className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-5 py-3 rounded-xl text-sm font-medium transition-colors"
            >
              Отправить
            </button>
          </div>
          <p className="text-xs text-gray-600 mt-2 text-center">Enter — отправить · Shift+Enter — новая строка</p>
        </div>
      </main>
    </div>
  );
}
