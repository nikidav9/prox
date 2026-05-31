"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { AGENTS, AgentDef } from "@/lib/agents";

type AgentState = "typing" | "walking" | "talking" | "idle";

interface AgentRT {
  def: AgentDef;
  deskIndex: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  state: AgentState;
  frame: number;
  bubble: string | null;
  bubbleTick: number;
  autoTick: number;
}

const W = 1000;
const H = 520;

const DESK_POSITIONS = [
  { x: 40, y: 130 },
  { x: 200, y: 130 },
  { x: 380, y: 130 },
  { x: 560, y: 130 },
  { x: 740, y: 130 },
  { x: 40, y: 320 },
  { x: 200, y: 320 },
  { x: 380, y: 320 },
  { x: 560, y: 320 },
  { x: 740, y: 320 },
];

function homePos(deskIndex: number) {
  const desk = DESK_POSITIONS[deskIndex];
  return { x: desk.x + 28, y: desk.y + 16 };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawBackground(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = "#0e0e1e";
  ctx.fillRect(0, 0, W, H * 0.5);
  ctx.fillStyle = "#161628";
  ctx.fillRect(0, H * 0.5, W, H * 0.5);
  ctx.strokeStyle = "#1e1e38";
  ctx.lineWidth = 1;
  for (let gx = 0; gx < W; gx += 40) {
    ctx.beginPath(); ctx.moveTo(gx, H * 0.5); ctx.lineTo(gx, H); ctx.stroke();
  }
  for (let gy = H * 0.5; gy < H; gy += 40) {
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
  }
  const wins = [60, 210, 390, 570, 740];
  for (const wx of wins) {
    ctx.fillStyle = "#1a1a3e";
    ctx.fillRect(wx, 18, 70, 70);
    ctx.strokeStyle = "#3a3a6e";
    ctx.lineWidth = 3;
    ctx.strokeRect(wx, 18, 70, 70);
    ctx.strokeStyle = "#3a3a6e";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(wx + 35, 18); ctx.lineTo(wx + 35, 88); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wx, 53); ctx.lineTo(wx + 70, 53); ctx.stroke();
    const stars = [[10,10],[20,25],[55,8],[62,30],[30,40],[8,45],[48,55],[15,60],[60,60],[35,62]];
    ctx.fillStyle = "#ffffff";
    for (const [sx, sy] of stars) {
      if (sx < 70 && sy < 70) ctx.fillRect(wx + sx, 18 + sy, 1, 1);
    }
    ctx.fillStyle = "#fffde7";
    ctx.beginPath(); ctx.arc(wx + 58, 30, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#1a1a3e";
    ctx.beginPath(); ctx.arc(wx + 61, 28, 6, 0, Math.PI * 2); ctx.fill();
  }
}

function drawDesk(ctx: CanvasRenderingContext2D, deskIndex: number, frameCount: number) {
  const { x, y } = DESK_POSITIONS[deskIndex];
  ctx.fillStyle = "#2a2040"; ctx.fillRect(x, y + 30, 90, 50);
  ctx.fillStyle = "#1e1535"; ctx.fillRect(x, y + 78, 90, 6);
  ctx.fillStyle = "#16102a";
  ctx.fillRect(x + 5, y + 82, 6, 20);
  ctx.fillRect(x + 79, y + 82, 6, 20);
  ctx.fillStyle = "#111827";
  roundRect(ctx, x + 18, y, 54, 38, 3); ctx.fill();
  ctx.strokeStyle = "#374151"; ctx.lineWidth = 2;
  roundRect(ctx, x + 18, y, 54, 38, 3); ctx.stroke();
  ctx.fillStyle = "#0d1117"; ctx.fillRect(x + 21, y + 3, 48, 30);
  const lineColors = ["#22c55e", "#60a5fa", "#f9a8d4", "#fbbf24"];
  const lineWidths = [30, 20, 35, 15, 25, 18];
  for (let li = 0; li < 5; li++) {
    const lw = lineWidths[li % lineWidths.length];
    const alpha = 0.6 + 0.4 * Math.sin(frameCount * 0.05 + li * 0.8);
    ctx.fillStyle = lineColors[li % lineColors.length];
    ctx.globalAlpha = alpha;
    ctx.fillRect(x + 23, y + 6 + li * 5, lw, 2);
  }
  ctx.globalAlpha = 1;
  if (Math.floor(frameCount / 30) % 2 === 0) {
    ctx.fillStyle = "#ffffff"; ctx.fillRect(x + 24, y + 30, 3, 4);
  }
  ctx.fillStyle = "#374151";
  ctx.fillRect(x + 40, y + 38, 10, 5);
  ctx.fillRect(x + 35, y + 42, 20, 3);
  ctx.fillStyle = "#1f2937";
  roundRect(ctx, x + 22, y + 55, 46, 14, 2); ctx.fill();
  ctx.fillStyle = "#374151";
  for (let ki = 0; ki < 8; ki++) ctx.fillRect(x + 24 + ki * 5, y + 57, 4, 4);
  for (let ki = 0; ki < 7; ki++) ctx.fillRect(x + 26 + ki * 5, y + 63, 4, 3);
}

function drawCharacter(ctx: CanvasRenderingContext2D, agent: AgentRT, frameCount: number) {
  const { x, y, state, def } = agent;
  const f = frameCount;
  const px = Math.round(x - 6);
  const py = Math.round(y - 11);
  let legPhase = 0, armPhase = 0;
  if (state === "walking") { legPhase = Math.sin(f * 0.2) * 3; armPhase = -Math.sin(f * 0.2) * 2; }
  const typingOffset = state === "typing" ? Math.sin(f * 0.15) * 0.5 : 0;
  const pyA = py + typingOffset;
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(px + 2, pyA + 20 + Math.max(0, legPhase), 4, 2);
  ctx.fillRect(px + 7, pyA + 20 - Math.max(0, -legPhase), 4, 2);
  ctx.fillStyle = "#1e293b";
  ctx.fillRect(px + 3, pyA + 15 + legPhase * 0.3, 3, 6);
  ctx.fillRect(px + 7, pyA + 15 - legPhase * 0.3, 3, 6);
  ctx.fillStyle = def.shirtColor;
  ctx.fillRect(px + 2, pyA + 8, 9, 8);
  ctx.fillStyle = def.shirtColor;
  if (state === "typing") {
    ctx.fillRect(px - 1, pyA + 9, 3, 4);
    ctx.fillRect(px + 11, pyA + 9, 3, 4);
  } else {
    ctx.fillRect(px + 1, pyA + 9 + armPhase, 2, 5);
    ctx.fillRect(px + 10, pyA + 9 - armPhase, 2, 5);
  }
  ctx.fillStyle = "#d4a574"; ctx.fillRect(px + 5, pyA + 6, 3, 3);
  ctx.fillStyle = "#d4a574"; ctx.fillRect(px + 3, pyA + 1, 7, 6);
  ctx.fillStyle = def.hairColor;
  ctx.fillRect(px + 3, pyA + 1, 7, 2);
  ctx.fillRect(px + 3, pyA + 3, 2, 2);
  ctx.fillRect(px + 8, pyA + 3, 2, 2);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(px + 4, pyA + 3, 2, 2);
  ctx.fillRect(px + 7, pyA + 3, 2, 2);
  ctx.fillStyle = "#000000";
  ctx.fillRect(px + 5, pyA + 4, 1, 1);
  ctx.fillRect(px + 8, pyA + 4, 1, 1);
  ctx.fillStyle = "#7f1d1d";
  if (state === "talking") ctx.fillRect(px + 5, pyA + 6, 3, 2);
  else ctx.fillRect(px + 5, pyA + 6, 3, 1);
}

function drawNameBadge(ctx: CanvasRenderingContext2D, agent: AgentRT) {
  const desk = DESK_POSITIONS[agent.deskIndex];
  const bx = desk.x + 4, by = desk.y + 102;
  ctx.font = "bold 8px monospace";
  const tw = ctx.measureText(agent.def.name).width;
  ctx.fillStyle = "#0f0f1f";
  roundRect(ctx, bx, by, tw + 6, 12, 2); ctx.fill();
  ctx.strokeStyle = agent.def.shirtColor; ctx.lineWidth = 1;
  roundRect(ctx, bx, by, tw + 6, 12, 2); ctx.stroke();
  ctx.fillStyle = agent.def.shirtColor;
  ctx.fillText(agent.def.name, bx + 3, by + 9);
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if ((current + " " + w).trim().length > maxChars) {
      if (current) lines.push(current);
      current = w;
    } else {
      current = (current + " " + w).trim();
    }
    if (lines.length >= 2) break;
  }
  if (current && lines.length < 3) lines.push(current);
  return lines.slice(0, 3);
}

function drawBubble(ctx: CanvasRenderingContext2D, agent: AgentRT, text: string) {
  const bx = Math.round(agent.x);
  const by = Math.round(agent.y - 11);
  const lines = wrapText(text, 22);
  ctx.font = "bold 8px monospace";
  const lineH = 11;
  const maxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12;
  const bh = lines.length * lineH + 8;
  let bubX = bx - maxW / 2;
  let bubY = by - bh - 14;
  bubX = Math.max(2, Math.min(W - maxW - 2, bubX));
  if (bubY < 2) bubY = by + 14;
  ctx.fillStyle = "#0f0f1f";
  roundRect(ctx, bubX, bubY, maxW, bh, 4); ctx.fill();
  ctx.strokeStyle = agent.def.shirtColor; ctx.lineWidth = 2;
  roundRect(ctx, bubX, bubY, maxW, bh, 4); ctx.stroke();
  const tailX = Math.max(bubX + 8, Math.min(bubX + maxW - 8, bx));
  ctx.fillStyle = "#0f0f1f";
  ctx.beginPath(); ctx.moveTo(tailX - 5, bubY + bh); ctx.lineTo(tailX + 5, bubY + bh); ctx.lineTo(tailX, by - 2); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = agent.def.shirtColor; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(tailX - 5, bubY + bh); ctx.lineTo(tailX, by - 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(tailX + 5, bubY + bh); ctx.lineTo(tailX, by - 2); ctx.stroke();
  ctx.fillStyle = "#e2e8f0";
  for (let li = 0; li < lines.length; li++) ctx.fillText(lines[li], bubX + 6, bubY + 10 + li * lineH);
}

const AUTO_MESSAGES = ["Hey! Quick question?","Got a minute?","Check this out!","Need your opinion","Bug or feature?","Deploying soon!","PR ready for review","Stand-up in 5?"];
const AUTO_RESPONSES = ["Sure, what's up?","On it!","Looks good to me","Nice work!","Interesting...","Let me check","Approved!","Almost done!"];

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const agentsRef = useRef<AgentRT[]>([]);
  const frameRef = useRef(0);
  const rafRef = useRef<number>(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [chatHistories, setChatHistories] = useState<Record<string, { role: "user" | "model"; text: string }[]>>({});
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    agentsRef.current = AGENTS.map((def, i) => {
      const hp = homePos(i);
      return { def, deskIndex: i, x: hp.x, y: hp.y, tx: hp.x, ty: hp.y, state: "typing" as AgentState, frame: 0, bubble: null, bubbleTick: 0, autoTick: Math.floor(Math.random() * 500 + 100) };
    });
  }, []);

  const triggerAutoInteraction = useCallback((agents: AgentRT[]) => {
    for (const agent of agents) {
      agent.autoTick--;
      if (agent.autoTick <= 0 && agent.state === "typing") {
        const others = agents.filter((a) => a.def.id !== agent.def.id && a.state === "typing");
        if (others.length === 0) { agent.autoTick = Math.floor(Math.random() * 400 + 350); continue; }
        const target = others[Math.floor(Math.random() * others.length)];
        const tpos = homePos(target.deskIndex);
        agent.state = "walking"; agent.tx = tpos.x + 16; agent.ty = tpos.y;
        const msg = AUTO_MESSAGES[Math.floor(Math.random() * AUTO_MESSAGES.length)];
        const resp = AUTO_RESPONSES[Math.floor(Math.random() * AUTO_RESPONSES.length)];
        setTimeout(() => {
          agent.state = "talking"; agent.bubble = msg; agent.bubbleTick = 180;
          setTimeout(() => {
            target.state = "talking"; target.bubble = resp; target.bubbleTick = 150;
            setTimeout(() => {
              const hp = homePos(agent.deskIndex);
              agent.state = "walking"; agent.tx = hp.x; agent.ty = hp.y;
              setTimeout(() => { agent.state = "typing"; agent.autoTick = Math.floor(Math.random() * 450 + 350); }, 1200);
            }, 2000);
          }, 1000);
        }, 1500);
      }
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    function gameLoop() {
      if (!ctx) return;
      const agents = agentsRef.current;
      frameRef.current++;
      const fc = frameRef.current;
      for (const agent of agents) {
        const dx = agent.tx - agent.x, dy = agent.ty - agent.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 1) { agent.x = lerp(agent.x, agent.tx, 0.05); agent.y = lerp(agent.y, agent.ty, 0.05); }
        else { agent.x = agent.tx; agent.y = agent.ty; if (agent.state === "walking") agent.state = "talking"; }
        if (agent.bubbleTick > 0 && --agent.bubbleTick <= 0) agent.bubble = null;
        agent.frame++;
      }
      if (fc % 60 === 0) triggerAutoInteraction(agents);
      ctx.clearRect(0, 0, W, H);
      drawBackground(ctx);
      for (let i = 0; i < 10; i++) { drawDesk(ctx, i, fc); drawNameBadge(ctx, agents[i]); }
      const sorted = [...agents].sort((a, b) => a.y - b.y);
      for (const agent of sorted) drawCharacter(ctx, agent, fc);
      for (const agent of agents) if (agent.bubble) drawBubble(ctx, agent, agent.bubble);
      rafRef.current = requestAnimationFrame(gameLoop);
    }
    rafRef.current = requestAnimationFrame(gameLoop);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [triggerAutoInteraction]);

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (W / rect.width);
    const my = (e.clientY - rect.top) * (H / rect.height);
    let found: AgentRT | null = null;
    for (const agent of agentsRef.current) {
      if (mx >= agent.x - 10 && mx <= agent.x + 10 && my >= agent.y - 14 && my <= agent.y + 14) { found = agent; break; }
    }
    setSelectedId(found ? found.def.id : null);
  }

  async function sendMessage() {
    if (!inputText.trim() || !selectedId || sending) return;
    const msg = inputText.trim();
    setInputText(""); setSending(true);
    const history = chatHistories[selectedId] || [];
    const newHistory = [...history, { role: "user" as const, text: msg }];
    setChatHistories((prev) => ({ ...prev, [selectedId]: newHistory }));
    try {
      const res = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: msg, agentId: selectedId, history }) });
      const data = await res.json();
      const reply = (data.text as string) || "...";
      setChatHistories((prev) => ({ ...prev, [selectedId]: [...(prev[selectedId] || []), { role: "model" as const, text: reply }] }));
      const agent = agentsRef.current.find((a) => a.def.id === selectedId);
      if (agent) { agent.bubble = reply.slice(0, 60); agent.bubbleTick = 240; agent.state = "talking"; setTimeout(() => { if (agent.state === "talking") agent.state = "typing"; }, 4000); }
    } catch {
      setChatHistories((prev) => ({ ...prev, [selectedId]: [...(prev[selectedId] || []), { role: "model" as const, text: "Connection error..." }] }));
    } finally { setSending(false); }
  }

  const selectedAgent = AGENTS.find((a) => a.id === selectedId);
  const chatHistory = selectedId ? chatHistories[selectedId] || [] : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#07071a", fontFamily: "monospace", color: "#e2e8f0", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", background: "#0f0f2e", borderBottom: "2px solid #1e1e4e", flexShrink: 0 }}>
        <span style={{ fontSize: 16, fontWeight: "bold", letterSpacing: 1 }}>🦞 Gemini Dev Studio</span>
        <div style={{ display: "flex", gap: 6, marginLeft: 8 }}>
          {AGENTS.map((a) => (
            <div key={a.id} title={a.name} style={{ width: 10, height: 10, borderRadius: "50%", background: a.shirtColor, border: selectedId === a.id ? "2px solid #fff" : "2px solid transparent", cursor: "pointer" }}
              onClick={() => setSelectedId(selectedId === a.id ? null : a.id)} />
          ))}
        </div>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#64748b" }}>Click an agent to chat</span>
      </div>
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", padding: 8 }}>
          <canvas ref={canvasRef} width={W} height={H} onClick={handleCanvasClick}
            style={{ maxWidth: "100%", maxHeight: "100%", imageRendering: "pixelated", cursor: "crosshair", border: "2px solid #1e1e4e" }} />
        </div>
        {selectedAgent && (
          <div style={{ width: 320, display: "flex", flexDirection: "column", background: "#0c0c24", borderLeft: `3px solid ${selectedAgent.shirtColor}`, flexShrink: 0 }}>
            <div style={{ padding: "12px 16px", borderBottom: `2px solid ${selectedAgent.shirtColor}33`, background: "#0f0f2e" }}>
              <div style={{ fontWeight: "bold", fontSize: 14, color: selectedAgent.shirtColor }}>{selectedAgent.name}</div>
              <div style={{ fontSize: 11, color: "#64748b" }}>{selectedAgent.role}</div>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              {chatHistory.length === 0 && <div style={{ color: "#334155", fontSize: 11, textAlign: "center", marginTop: 40 }}>Start a conversation with {selectedAgent.name}</div>}
              {chatHistory.map((msg, i) => (
                <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
                  <div style={{ maxWidth: "80%", padding: "6px 10px", borderRadius: 8, fontSize: 12, lineHeight: 1.4, background: msg.role === "user" ? "#1e3a5f" : "#0f0f2e", border: msg.role === "model" ? `1px solid ${selectedAgent.shirtColor}44` : "none", color: msg.role === "user" ? "#bfdbfe" : "#e2e8f0" }}>{msg.text}</div>
                </div>
              ))}
              {sending && <div style={{ display: "flex", justifyContent: "flex-start" }}><div style={{ background: "#0f0f2e", border: `1px solid ${selectedAgent.shirtColor}44`, padding: "6px 10px", borderRadius: 8, fontSize: 12, color: "#64748b" }}>...</div></div>}
            </div>
            <div style={{ padding: 12, borderTop: `2px solid ${selectedAgent.shirtColor}33`, display: "flex", gap: 8 }}>
              <input value={inputText} onChange={(e) => setInputText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                placeholder="Type a message..." disabled={sending}
                style={{ flex: 1, background: "#0f0f2e", border: `1px solid ${selectedAgent.shirtColor}44`, borderRadius: 6, padding: "6px 10px", color: "#e2e8f0", fontSize: 12, outline: "none" }} />
              <button onClick={sendMessage} disabled={sending || !inputText.trim()}
                style={{ background: selectedAgent.shirtColor, border: "none", borderRadius: 6, padding: "6px 12px", color: "#000", fontWeight: "bold", fontSize: 12, cursor: sending ? "wait" : "pointer", opacity: sending || !inputText.trim() ? 0.5 : 1 }}>
                {sending ? "..." : "Send"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
