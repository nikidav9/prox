"use client";

import { useState, useRef, useEffect } from "react";
import { AGENTS, Agent } from "@/lib/agents";

type Message = { role: "user" | "model"; text: string };
type Histories = Record<string, Message[]>;
type View = "agents" | "chat";

export default function Home() {
  const [view, setView] = useState<View>("agents");
  const [activeAgent, setActiveAgent] = useState<Agent | null>(null);
  const [histories, setHistories] = useState<Histories>({});
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const messages = activeAgent ? (histories[activeAgent.id] || []) : [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function openChat(agent: Agent) {
    setActiveAgent(agent);
    setView("chat");
  }

  async function send() {
    if (!input.trim() || loading || !activeAgent) return;
    const userText = input.trim();
    setInput("");

    const history = histories[activeAgent.id] || [];
    const updated = [...history, { role: "user" as const, text: userText }];
    setHistories((h) => ({ ...h, [activeAgent.id]: updated }));
    setLoading(true);

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userText, agentId: activeAgent.id, history }),
      });
      const data = await res.json();
      if (data.text) {
        setHistories((h) => ({
          ...h,
          [activeAgent.id]: [...updated, { role: "model", text: data.text }],
        }));
      }
    } finally {
      setLoading(false);
    }
  }

  const filtered = AGENTS.filter(
    (a) =>
      a.name.toLowerCase().includes(search.toLowerCase()) ||
      a.tagline.toLowerCase().includes(search.toLowerCase()) ||
      a.tags.some((t) => t.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="min-h-screen bg-[#0d0d0f] text-white font-sans">
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/5 bg-[#0d0d0f]/80 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
          <button
            onClick={() => setView("agents")}
            className="flex items-center gap-2 font-semibold text-base tracking-tight"
          >
            <span className="text-xl">🦞</span>
            <span className="text-white">Gemini</span>
            <span className="text-purple-400">Agents</span>
          </button>
          <div className="flex items-center gap-6 text-sm text-white/50">
            <button onClick={() => setView("agents")} className={view === "agents" ? "text-white" : "hover:text-white/80 transition-colors"}>
              Агенты
            </button>
            {activeAgent && (
              <button onClick={() => setView("chat")} className={view === "chat" ? "text-white" : "hover:text-white/80 transition-colors"}>
                Чат
              </button>
            )}
          </div>
        </div>
      </nav>

      {view === "agents" && (
        <div className="pt-14 max-w-7xl mx-auto px-6 py-12">
          <div className="mb-10">
            <h1 className="text-4xl font-bold mb-2">Агенты</h1>
            <p className="text-white/40 text-lg">Выбери персонажа — каждый со своей личностью и специализацией</p>
          </div>

          <div className="mb-8 relative max-w-md">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-white/30 text-sm">🔍</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск агентов..."
              className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-2.5 text-sm placeholder-white/30 focus:outline-none focus:border-white/20 transition-colors"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((agent) => {
              const msgCount = Math.floor((histories[agent.id]?.length || 0) / 2);
              return (
                <button
                  key={agent.id}
                  onClick={() => openChat(agent)}
                  className="group relative text-left bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.07] hover:border-white/[0.15] rounded-2xl p-5 transition-all duration-200"
                >
                  <div
                    className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
                    style={{ boxShadow: `inset 0 0 30px ${agent.color}10` }}
                  />
                  <div className="flex items-start justify-between mb-4">
                    <div
                      className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl"
                      style={{ backgroundColor: `${agent.color}20` }}
                    >
                      {agent.emoji}
                    </div>
                    {msgCount > 0 && (
                      <span className="text-xs bg-white/10 text-white/50 rounded-full px-2 py-0.5">
                        {msgCount} сообщ.
                      </span>
                    )}
                  </div>
                  <h3 className="font-semibold text-base mb-0.5">{agent.name}</h3>
                  <p className="text-sm mb-3" style={{ color: agent.color }}>{agent.tagline}</p>
                  <p className="text-white/40 text-xs leading-relaxed mb-4">{agent.description}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {agent.tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-xs px-2 py-0.5 rounded-full border"
                        style={{ borderColor: `${agent.color}30`, color: `${agent.color}90` }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className="mt-4 pt-4 border-t border-white/[0.05] flex items-center justify-between">
                    <span className="text-xs text-white/30">gemini-1.5-flash</span>
                    <span
                      className="text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity"
                      style={{ color: agent.color }}
                    >
                      Начать →
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {filtered.length === 0 && (
            <div className="text-center py-20 text-white/30">
              <p className="text-4xl mb-3">🔍</p>
              <p>Ничего не найдено</p>
            </div>
          )}
        </div>
      )}

      {view === "chat" && activeAgent && (
        <div className="pt-14 flex h-screen">
          <aside className="w-72 border-r border-white/5 bg-[#0d0d0f] flex flex-col pt-4 overflow-y-auto">
            <div className="px-4 mb-3">
              <p className="text-xs text-white/30 uppercase tracking-wider font-medium px-2">Агенты</p>
            </div>
            {AGENTS.map((agent) => {
              const isActive = activeAgent.id === agent.id;
              const msgCount = Math.floor((histories[agent.id]?.length || 0) / 2);
              return (
                <button
                  key={agent.id}
                  onClick={() => setActiveAgent(agent)}
                  className={`flex items-center gap-3 mx-2 px-3 py-2.5 rounded-xl text-left transition-colors ${
                    isActive ? "bg-white/[0.07]" : "hover:bg-white/[0.04]"
                  }`}
                >
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-base flex-shrink-0"
                    style={{ backgroundColor: `${agent.color}20` }}
                  >
                    {agent.emoji}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className={`text-sm font-medium ${isActive ? "text-white" : "text-white/60"}`}>
                        {agent.name}
                      </span>
                      {msgCount > 0 && (
                        <span className="text-xs text-white/30">{msgCount}</span>
                      )}
                    </div>
                    <p className="text-xs truncate" style={{ color: `${agent.color}70` }}>
                      {agent.tagline}
                    </p>
                  </div>
                </button>
              );
            })}
            <div className="mt-auto p-4 border-t border-white/5">
              <button
                onClick={() => setHistories((h) => ({ ...h, [activeAgent.id]: [] }))}
                className="w-full text-xs text-white/20 hover:text-red-400 transition-colors py-1"
              >
                Очистить историю
              </button>
            </div>
          </aside>

          <main className="flex-1 flex flex-col min-w-0">
            <div className="px-6 py-4 border-b border-white/5 flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center text-lg flex-shrink-0"
                style={{ backgroundColor: `${activeAgent.color}20` }}
              >
                {activeAgent.emoji}
              </div>
              <div>
                <h2 className="font-semibold text-sm">{activeAgent.name}</h2>
                <p className="text-xs" style={{ color: `${activeAgent.color}90` }}>{activeAgent.tagline}</p>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
                <span className="text-xs text-white/30">онлайн</span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <div
                    className="w-16 h-16 rounded-2xl flex items-center justify-center text-3xl mb-4"
                    style={{ backgroundColor: `${activeAgent.color}15` }}
                  >
                    {activeAgent.emoji}
                  </div>
                  <h3 className="font-semibold text-lg mb-1">{activeAgent.name}</h3>
                  <p className="text-white/30 text-sm max-w-xs">{activeAgent.description}</p>
                  <div className="flex flex-wrap gap-2 mt-4 justify-center">
                    {activeAgent.tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-xs px-3 py-1 rounded-full border"
                        style={{ borderColor: `${activeAgent.color}30`, color: `${activeAgent.color}80` }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((msg, i) => (
                <div key={i} className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                  {msg.role === "model" && (
                    <div
                      className="w-8 h-8 rounded-xl flex items-center justify-center text-sm flex-shrink-0 mt-0.5"
                      style={{ backgroundColor: `${activeAgent.color}20` }}
                    >
                      {activeAgent.emoji}
                    </div>
                  )}
                  <div
                    className={`max-w-[75%] px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                      msg.role === "user"
                        ? "bg-white/[0.08] text-white rounded-tr-sm"
                        : "bg-white/[0.04] border border-white/[0.06] text-white/85 rounded-tl-sm"
                    }`}
                  >
                    {msg.text}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex gap-3">
                  <div
                    className="w-8 h-8 rounded-xl flex items-center justify-center text-sm flex-shrink-0"
                    style={{ backgroundColor: `${activeAgent.color}20` }}
                  >
                    {activeAgent.emoji}
                  </div>
                  <div className="bg-white/[0.04] border border-white/[0.06] px-4 py-3 rounded-2xl rounded-tl-sm">
                    <div className="flex gap-1.5 items-center">
                      {[0, 150, 300].map((delay) => (
                        <span
                          key={delay}
                          className="w-1.5 h-1.5 rounded-full animate-bounce"
                          style={{ backgroundColor: activeAgent.color, animationDelay: `${delay}ms` }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            <div className="px-6 py-4 border-t border-white/5">
              <div className="flex gap-3 items-end bg-white/[0.04] border border-white/[0.08] rounded-2xl px-4 py-3 focus-within:border-white/20 transition-colors">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder={`Напиши ${activeAgent.name}...`}
                  rows={1}
                  className="flex-1 bg-transparent text-sm resize-none focus:outline-none placeholder-white/20 text-white/90"
                  style={{ maxHeight: "120px" }}
                />
                <button
                  onClick={send}
                  disabled={loading || !input.trim()}
                  className="flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-all disabled:opacity-20"
                  style={{ backgroundColor: input.trim() ? activeAgent.color : "transparent", border: `1px solid ${activeAgent.color}40` }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                </button>
              </div>
              <p className="text-xs text-white/20 mt-2 text-center">Enter — отправить · Shift+Enter — новая строка</p>
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
