import { GoogleGenerativeAI, Tool, SchemaType } from "@google/generative-ai";
import Groq from "groq-sdk";
import { NextRequest, NextResponse } from "next/server";
import { AGENTS } from "@/lib/agents";
import { loadHistory, saveHistory, ChatMsg } from "@/lib/supabase";

export const maxDuration = 60;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

// ── Model pool ────────────────────────────────────────────────────────────────────────────
type Provider = "gemini" | "groq";
interface ModelEntry { id: string; provider: Provider; model: string }

const MODEL_POOL: ModelEntry[] = [
  { id: "gemini-2.0-flash",        provider: "gemini", model: "gemini-2.0-flash" },
  { id: "gemini-1.5-flash",        provider: "gemini", model: "gemini-1.5-flash" },
  { id: "groq-llama33-70b",        provider: "groq",   model: "llama-3.3-70b-versatile" },
  { id: "groq-llama31-8b",         provider: "groq",   model: "llama-3.1-8b-instant" },
  { id: "groq-gemma2-9b",          provider: "groq",   model: "gemma2-9b-it" },
  { id: "groq-deepseek-70b",       provider: "groq",   model: "deepseek-r1-distill-llama-70b" },
  { id: "groq-qwen-32b",           provider: "groq",   model: "qwen-qwq-32b" },
  { id: "groq-llama3-70b",         provider: "groq",   model: "llama3-70b-8192" },
  { id: "groq-llama31-70b",        provider: "groq",   model: "llama-3.1-70b-versatile" },
];

const cooldowns = new Map<string, number>();

function availableModels(): ModelEntry[] {
  const now = Date.now();
  return MODEL_POOL.filter(m => (cooldowns.get(m.id) ?? 0) <= now);
}

function markCooled(id: string, msg: string) {
  const secMatch = msg.match(/try again in ([\d.]+)s/i) || msg.match(/retry in ([\d.]+)s/i);
  const minMatch = msg.match(/try again in (\d+)m/i);
  const waitMs = secMatch
    ? Math.ceil(parseFloat(secMatch[1]) * 1000)
    : minMatch ? parseInt(minMatch[1]) * 60_000
    : 20 * 60_000;
  cooldowns.set(id, Date.now() + Math.min(waitMs + 5000, 24 * 3600_000));
}

// ── Context compression ────────────────────────────────────────────────────────────────────
const KEEP_RECENT = 4;
const COMPRESS_AT = 12;

async function compressHistory(messages: ChatMsg[]): Promise<ChatMsg[]> {
  if (!groq || messages.length <= COMPRESS_AT) return messages;
  const toSummarize = messages.slice(0, -KEEP_RECENT);
  const recent = messages.slice(-KEEP_RECENT);
  const summaryPrefix = toSummarize[0]?.role === "system" && toSummarize[0].text.startsWith("📋")
    ? toSummarize[0].text + "\n\n" : "";
  const dialog = toSummarize.filter(m => m.role !== "system")
    .map(m => `${m.role === "user" ? "Пользователь" : "Агент"}: ${m.text.slice(0, 400)}`).join("\n");
  const compressMsg = [{ role: "user" as const, content: `${summaryPrefix}Сделай краткое техническое резюме этого диалога (3-7 пунктов, только факты и решения, без воды):\n\n${dialog}` }];
  try {
    let res;
    for (const m of ["llama-3.1-8b-instant", "gemma2-9b-it", "llama-3.3-70b-versatile"]) {
      try { res = await groq.chat.completions.create({ model: m, messages: compressMsg, max_tokens: 300 }); break; }
      catch { /* try next */ }
    }
    if (!res) return messages.slice(-COMPRESS_AT);
    const summary = res.choices[0]?.message?.content || "";
    return [{ role: "system", text: `📋 Резюме предыдущего диалога:\n${summary}` }, ...recent];
  } catch {
    return messages.slice(-COMPRESS_AT);
  }
}

// ── GitHub helpers ────────────────────────────────────────────────────────────────────────────
async function githubFetch(token: string, path: string, method = "GET", body?: object) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function runGithubTool(name: string, args: Record<string, unknown>, token: string): Promise<object> {
  try {
    switch (name) {
      case "github_get_user": return await githubFetch(token, "/user");
      case "github_list_repos": return await githubFetch(token, "/user/repos?per_page=20&sort=updated");
      case "github_create_repo": return await githubFetch(token, "/user/repos", "POST", {
        name: args.name, description: args.description ?? "", private: args.private ?? false, auto_init: args.auto_init ?? true,
      });
      case "github_get_repo": return await githubFetch(token, `/repos/${args.owner}/${args.repo}`);
      case "github_create_or_update_file": {
        const content = Buffer.from(String(args.content)).toString("base64");
        let sha: string | undefined;
        try { const ex = await githubFetch(token, `/repos/${args.owner}/${args.repo}/contents/${args.path}`); if ((ex as Record<string,unknown>).sha) sha = (ex as Record<string,unknown>).sha as string; } catch {}
        return await githubFetch(token, `/repos/${args.owner}/${args.repo}/contents/${args.path}`, "PUT", {
          message: args.message ?? "Update file", content, ...(sha ? { sha } : {}), branch: args.branch ?? "main",
        });
      }
      case "github_create_branch": {
        const repo = await githubFetch(token, `/repos/${args.owner}/${args.repo}`) as Record<string,unknown>;
        const ref = await githubFetch(token, `/repos/${args.owner}/${args.repo}/git/refs/heads/${repo.default_branch ?? "main"}`) as Record<string,unknown>;
        return await githubFetch(token, `/repos/${args.owner}/${args.repo}/git/refs`, "POST", { ref: `refs/heads/${args.branch}`, sha: (ref.object as Record<string,unknown>)?.sha });
      }
      case "github_list_issues": return await githubFetch(token, `/repos/${args.owner}/${args.repo}/issues?state=open`);
      case "github_create_issue": return await githubFetch(token, `/repos/${args.owner}/${args.repo}/issues`, "POST", { title: args.title, body: args.body ?? "", labels: args.labels ?? [] });
      case "github_list_files": return await githubFetch(token, `/repos/${args.owner}/${args.repo}/contents/${args.path ?? ""}`);
      default: return { error: `Unknown tool: ${name}` };
    }
  } catch (err) { return { error: String(err) }; }
}

// ── Gemini tool definitions ───────────────────────────────────────────────────────────────────────────
const GITHUB_TOOLS: Tool[] = [{
  functionDeclarations: [
    { name: "github_get_user", description: "Get the authenticated GitHub user info", parameters: { type: SchemaType.OBJECT, properties: {} } },
    { name: "github_list_repos", description: "List the user's GitHub repositories", parameters: { type: SchemaType.OBJECT, properties: {} } },
    { name: "github_create_repo", description: "Create a new GitHub repository", parameters: { type: SchemaType.OBJECT, properties: { name: { type: SchemaType.STRING }, description: { type: SchemaType.STRING }, private: { type: SchemaType.BOOLEAN }, auto_init: { type: SchemaType.BOOLEAN } }, required: ["name"] } },
    { name: "github_get_repo", description: "Get info about a GitHub repository", parameters: { type: SchemaType.OBJECT, properties: { owner: { type: SchemaType.STRING }, repo: { type: SchemaType.STRING } }, required: ["owner", "repo"] } },
    { name: "github_create_or_update_file", description: "Create or update a file in a GitHub repository", parameters: { type: SchemaType.OBJECT, properties: { owner: { type: SchemaType.STRING }, repo: { type: SchemaType.STRING }, path: { type: SchemaType.STRING }, content: { type: SchemaType.STRING }, message: { type: SchemaType.STRING }, branch: { type: SchemaType.STRING } }, required: ["owner", "repo", "path", "content", "message"] } },
    { name: "github_create_branch", description: "Create a new branch in a repository", parameters: { type: SchemaType.OBJECT, properties: { owner: { type: SchemaType.STRING }, repo: { type: SchemaType.STRING }, branch: { type: SchemaType.STRING } }, required: ["owner", "repo", "branch"] } },
    { name: "github_list_files", description: "List files in a repository directory", parameters: { type: SchemaType.OBJECT, properties: { owner: { type: SchemaType.STRING }, repo: { type: SchemaType.STRING }, path: { type: SchemaType.STRING } }, required: ["owner", "repo"] } },
    { name: "github_list_issues", description: "List open issues in a repository", parameters: { type: SchemaType.OBJECT, properties: { owner: { type: SchemaType.STRING }, repo: { type: SchemaType.STRING } }, required: ["owner", "repo"] } },
    { name: "github_create_issue", description: "Create a new GitHub issue", parameters: { type: SchemaType.OBJECT, properties: { owner: { type: SchemaType.STRING }, repo: { type: SchemaType.STRING }, title: { type: SchemaType.STRING }, body: { type: SchemaType.STRING }, labels: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } } }, required: ["owner", "repo", "title"] } },
  ],
}];

function buildGroqTools(hasGithub: boolean) {
  return [
    { type: "function" as const, function: { name: "consult_agent", description: "Ask a colleague agent a specific question", parameters: { type: "object", properties: { agentId: { type: "string", description: `Agent ID, one of: ${AGENTS.map(a=>a.id).join(", ")}` }, question: { type: "string" } }, required: ["agentId","question"] } } },
    ...(hasGithub ? [
      { type: "function" as const, function: { name: "github_get_user", description: "Get authenticated GitHub user", parameters: { type: "object", properties: {} } } },
      { type: "function" as const, function: { name: "github_list_repos", description: "List user repos", parameters: { type: "object", properties: {} } } },
      { type: "function" as const, function: { name: "github_create_repo", description: "Create a new repo", parameters: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, private: { type: "boolean" }, auto_init: { type: "boolean" } }, required: ["name"] } } },
      { type: "function" as const, function: { name: "github_create_or_update_file", description: "Create or update file in repo", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" }, content: { type: "string" }, message: { type: "string" }, branch: { type: "string" } }, required: ["owner", "repo", "path", "content", "message"] } } },
      { type: "function" as const, function: { name: "github_create_branch", description: "Create a branch", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, branch: { type: "string" } }, required: ["owner", "repo", "branch"] } } },
      { type: "function" as const, function: { name: "github_list_files", description: "List files in repo", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" } }, required: ["owner", "repo"] } } },
      { type: "function" as const, function: { name: "github_list_issues", description: "List open issues", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } } },
      { type: "function" as const, function: { name: "github_create_issue", description: "Create an issue", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["owner", "repo", "title"] } } },
    ] : []),
  ];
}

async function consultAgent(targetId: string, question: string, githubToken: string, depth: number): Promise<string> {
  if (depth >= 2) return "[максимальная глубина цепочки достигнута]";
  const target = AGENTS.find(a => a.id === targetId);
  if (!target) return `[агент не найден: ${targetId}. Доступные id: ${AGENTS.map(a=>a.id).join(", ")}]`;
  try {
    const baseUrl = process.env.APP_URL || "https://gemini-agents-mocha.vercel.app";
    const res = await fetch(`${baseUrl}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: question, agentId: targetId, history: [], githubToken, _depth: depth + 1 }),
    });
    const data = await res.json();
    return data.text || "[нет ответа]";
  } catch (e) {
    return `[ошибка консультации: ${String(e).slice(0, 100)}]`;
  }
}

export async function GET() {
  const now = Date.now();
  return NextResponse.json({
    version: 7,
    pool: MODEL_POOL.map(m => ({
      id: m.id, model: m.model,
      available: (cooldowns.get(m.id) ?? 0) <= now,
      cooldownUntil: cooldowns.get(m.id) ? new Date(cooldowns.get(m.id)!).toISOString() : null,
    })),
    groqConfigured: !!groq,
  });
}

export async function POST(req: NextRequest) {
  try {
    const { message, agentId, history, githubToken: clientToken, _depth = 0 } = await req.json();
    if (!message || !agentId) return NextResponse.json({ error: "message and agentId required" }, { status: 400 });
    const agent = AGENTS.find((a) => a.id === agentId);
    if (!agent) return NextResponse.json({ error: "Unknown agent" }, { status: 400 });

    const githubToken = clientToken?.trim() || process.env.GITHUB_TOKEN || "";
    const hasGithub = !!githubToken;

    const agentList = AGENTS.map(a => `${a.id} — ${a.name} (${a.role})`).join("\n");
    const systemInstruction = agent.soul
      + (hasGithub ? "\n\nУ тебя есть доступ к GitHub через инструменты. Делай сразу, сначала вызывай github_get_user." : "")
      + `\n\nТЫ МОЖЕШЬ КОНСУЛЬТИРОВАТЬСЯ С КОЛЛЕГАМИ через consult_agent.\nСписок агентов:\n${agentList}`;

    const stored: ChatMsg[] = await loadHistory(agentId);
    const fullHistory: ChatMsg[] = stored.length > 0 ? stored : (history || []);
    const compressedHistory = await compressHistory(fullHistory);
    const userMsg: ChatMsg = { role: "user", text: message };
    await saveHistory(agentId, [...compressedHistory, userMsg]);

    const trimmedHistory = compressedHistory.filter(m => m.role === "user" || m.role === "model");
    const groqHistory = compressedHistory.filter(m => m.role === "user" || m.role === "model")
      .map(m => ({ role: (m.role === "model" ? "assistant" : "user") as "user" | "assistant", content: m.text }));

    let text = "";
    const githubActions: string[] = [];
    let lastError = "";
    let usedProvider = "";

    for (const entry of availableModels()) {
      try {
        if (entry.provider === "gemini") {
          const gModel = genAI.getGenerativeModel({
            model: entry.model, systemInstruction,
            tools: hasGithub ? GITHUB_TOOLS : [],
          });
          const chat = gModel.startChat({
            history: trimmedHistory.map(msg => ({ role: msg.role, parts: [{ text: msg.text }] })),
          });
          // Fail fast — no retries, move to next model on any error
          let result = await chat.sendMessage(message, { generationConfig: { maxOutputTokens: 800 } } as never);
          for (let i = 0; i < 8; i++) {
            const parts = result.response.candidates?.[0]?.content?.parts ?? [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const calls = parts.filter((p: any) => p.functionCall);
            if (calls.length === 0) break;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const responses = await Promise.all(calls.map(async (part: any) => {
              const fc = part.functionCall!;
              const toolResult = await runGithubTool(fc.name, fc.args as Record<string,unknown>, githubToken);
              githubActions.push(`${fc.name}: ${JSON.stringify(toolResult).slice(0, 150)}`);
              return { functionResponse: { name: fc.name, response: toolResult } };
            }));
            result = await chat.sendMessage(responses as Parameters<typeof chat.sendMessage>[0], { generationConfig: { maxOutputTokens: 800 } } as never);
          }
          text = result.response.text();
          usedProvider = entry.id;
          break;

        } else if (entry.provider === "groq" && groq) {
          const groqMessages: Groq.Chat.ChatCompletionMessageParam[] = [
            { role: "system", content: systemInstruction },
            ...groqHistory,
            { role: "user", content: message },
          ];
          const groqTools = buildGroqTools(hasGithub);

          for (let round = 0; round < 6; round++) {
            const groqRes = await groq.chat.completions.create({
              model: entry.model, messages: groqMessages,
              max_tokens: 1024, tools: groqTools, tool_choice: "auto",
            });
            const choice = groqRes.choices[0];
            const msg = choice.message;
            groqMessages.push(msg as Groq.Chat.ChatCompletionMessageParam);
            if (!msg.tool_calls || msg.tool_calls.length === 0) {
              text = msg.content || "Нет ответа";
              break;
            }
            for (const tc of msg.tool_calls) {
              const args = JSON.parse(tc.function.arguments || "{}");
              let toolResult: object;
              if (tc.function.name === "consult_agent") {
                const reply = await consultAgent(String(args.agentId), String(args.question), githubToken, _depth);
                toolResult = { reply };
                githubActions.push(`👥 ${args.agentId}: ${reply.slice(0, 120)}`);
              } else {
                toolResult = await runGithubTool(tc.function.name, args, githubToken);
                githubActions.push(`${tc.function.name}: ${JSON.stringify(toolResult).slice(0, 150)}`);
              }
              groqMessages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(toolResult) });
            }
          }
          usedProvider = entry.id;
          break;
        }
      } catch (err) {
        const errMsg = String(err);
        lastError = errMsg;
        markCooled(entry.id, errMsg);
        console.log(`[rotation] ${entry.id} failed (${errMsg.slice(0, 80)}), trying next...`);
        continue;
      }
    }

    if (!text) {
      const allExhausted = availableModels().length === 0;
      const errorMsg = allExhausted
        ? "Все модели на перерыве (лимиты квот), попробуйте через несколько минут."
        : `Не удалось получить ответ. Последняя ошибка: ${lastError.slice(0, 200)}`;
      return NextResponse.json({ error: errorMsg }, { status: 429 });
    }

    const botMsg: ChatMsg = { role: "model", text, ...(githubActions.length ? { githubActions } : {}) };
    await saveHistory(agentId, [...compressedHistory, userMsg, botMsg]);

    return NextResponse.json({
      text, agentName: agent.name,
      githubActions: githubActions.length ? githubActions : undefined,
      provider: usedProvider,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[agent] outer catch:", msg);
    const isRate = msg.includes("429") || msg.includes("quota") || msg.includes("rate_limit") || msg.includes("RESOURCE_EXHAUSTED");
    const retryMatch = msg.match(/try again in (\d+)m/i) || msg.match(/retry in ([\d.]+)s/i);
    const retryAfter = retryMatch ? (msg.includes("m") ? parseInt(retryMatch[1]) * 60 : Math.ceil(parseFloat(retryMatch[1]))) : null;
    return NextResponse.json({ error: msg, retryAfter }, { status: isRate ? 429 : 500 });
  }
}
