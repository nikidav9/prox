import { GoogleGenerativeAI, Tool, SchemaType } from "@google/generative-ai";
import Groq from "groq-sdk";
import { NextRequest, NextResponse } from "next/server";
import { AGENTS } from "@/lib/agents";
import { loadHistory, saveHistory, ChatMsg } from "@/lib/supabase";

export const maxDuration = 60;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;
const cerebrasKey = process.env.CEREBRAS_API_KEY || "";

type Provider = "gemini" | "groq" | "openrouter" | "cerebras";
interface ModelEntry { id: string; provider: Provider; model: string }

const MODEL_POOL: ModelEntry[] = [
  // ── OpenRouter (20 free models) ──────────────────────────────────────
  { id: "or-llama4-maverick",      provider: "openrouter", model: "meta-llama/llama-4-maverick:free" },
  { id: "or-llama4-scout",         provider: "openrouter", model: "meta-llama/llama-4-scout:free" },
  { id: "or-deepseek-v3",          provider: "openrouter", model: "deepseek/deepseek-v3-0324:free" },
  { id: "or-deepseek-r1",          provider: "openrouter", model: "deepseek/deepseek-r1:free" },
  { id: "or-qwen3-235b",           provider: "openrouter", model: "qwen/qwen3-235b-a22b:free" },
  { id: "or-qwen3-30b",            provider: "openrouter", model: "qwen/qwen3-30b-a3b:free" },
  { id: "or-kimi-k2",              provider: "openrouter", model: "moonshotai/kimi-k2:free" },
  { id: "or-gpt-oss-120b",         provider: "openrouter", model: "openai/gpt-oss-120b:free" },
  { id: "or-llama33-70b",          provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free" },
  { id: "or-hermes-405b",          provider: "openrouter", model: "nousresearch/hermes-3-llama-3.1-405b:free" },
  { id: "or-gemma4-31b",           provider: "openrouter", model: "google/gemma-4-31b-it:free" },
  { id: "or-gemma3-27b",           provider: "openrouter", model: "google/gemma-3-27b-it:free" },
  { id: "or-mistral-small",        provider: "openrouter", model: "mistralai/mistral-small-3.2-24b-instruct:free" },
  { id: "or-mai-ds-r1",            provider: "openrouter", model: "microsoft/mai-ds-r1:free" },
  { id: "or-nemotron-120b",        provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free" },
  { id: "or-deepseek-r1-llama",    provider: "openrouter", model: "deepseek/deepseek-r1-distill-llama-70b:free" },
  { id: "or-chimera",              provider: "openrouter", model: "tngtech/deepseek-r1t-chimera:free" },
  { id: "or-glm4-32b",             provider: "openrouter", model: "thudm/glm-4-32b:free" },
  { id: "or-qwen3-14b",            provider: "openrouter", model: "qwen/qwen3-14b:free" },
  { id: "or-llama31-405b",         provider: "openrouter", model: "meta-llama/llama-3.1-405b-instruct:free" },
  // ── Cerebras (ultra-fast, generous free limits) ──────────────────────
  { id: "cb-llama4-scout",         provider: "cerebras",   model: "llama-4-scout-17b-16e-instruct" },
  { id: "cb-llama33-70b",          provider: "cerebras",   model: "llama-3.3-70b" },
  { id: "cb-llama31-70b",          provider: "cerebras",   model: "llama3.1-70b" },
  { id: "cb-qwen3-32b",            provider: "cerebras",   model: "qwen-3-32b" },
  // ── Groq (fast, daily quota) ─────────────────────────────────────────
  { id: "groq-llama4-maverick",    provider: "groq",   model: "meta-llama/llama-4-maverick-17b-128e-instruct" },
  { id: "groq-llama4-scout",       provider: "groq",   model: "meta-llama/llama-4-scout-17b-16e-instruct" },
  { id: "groq-llama33-70b",        provider: "groq",   model: "llama-3.3-70b-versatile" },
  { id: "groq-llama3-70b",         provider: "groq",   model: "llama3-70b-8192" },
  { id: "groq-deepseek-r1",        provider: "groq",   model: "deepseek-r1-distill-llama-70b" },
  { id: "groq-qwq-32b",            provider: "groq",   model: "qwen-qwq-32b" },
  { id: "groq-mixtral",            provider: "groq",   model: "mixtral-8x7b-32768" },
  { id: "groq-gemma2",             provider: "groq",   model: "gemma2-9b-it" },
  // ── Gemini (last resort) ─────────────────────────────────────────────
  { id: "gemini-2.0-flash",        provider: "gemini", model: "gemini-2.0-flash" },
  { id: "gemini-2.5-flash",        provider: "gemini", model: "gemini-2.5-flash-preview-05-20" },
];

const cooldowns = new Map<string, number>();
let roundRobinIdx = 0; // rotate starting model to spread load evenly

function availableModels(): ModelEntry[] {
  const now = Date.now();
  return MODEL_POOL.filter(m => (cooldowns.get(m.id) ?? 0) <= now);
}

// Return models in rotated order so load spreads across all providers
function rotatedModels(): ModelEntry[] {
  const avail = availableModels();
  if (avail.length === 0) return [];
  const start = roundRobinIdx % avail.length;
  roundRobinIdx = (roundRobinIdx + 1) % Math.max(MODEL_POOL.length, 1);
  return [...avail.slice(start), ...avail.slice(0, start)];
}

function markCooled(id: string, msg: string) {
  const secMatch = msg.match(/try again in ([\d.]+)s/i) || msg.match(/retry in ([\d.]+)s/i);
  const minMatch = msg.match(/try again in (\d+)m/i);
  const isQuota = msg.includes("quota") || msg.includes("429") || msg.includes("rate") || msg.includes("limit");
  const waitMs = secMatch
    ? Math.ceil(parseFloat(secMatch[1]) * 1000)
    : minMatch ? parseInt(minMatch[1]) * 60_000
    : isQuota ? 120_000 : 30_000;
  const until = Date.now() + Math.min(waitMs + 5000, 24 * 3600_000);
  cooldowns.set(id, until);
  // Cool all models of same provider on quota errors (they share quota)
  const entry = MODEL_POOL.find(m => m.id === id);
  if (entry && isQuota && (entry.provider === "gemini" || entry.provider === "cerebras")) {
    MODEL_POOL.filter(m => m.provider === entry.provider).forEach(m => cooldowns.set(m.id, until));
  }
}

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

function buildGeminiTools(hasGithub: boolean): Tool[] {
  const agentListStr = AGENTS.map(a => `${a.id} (${a.name})`).join(", ");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allDeclarations: any[] = [
    { name: "consult_agent", description: `Спросить коллегу-агента. Доступные агенты: ${agentListStr}`, parameters: { type: "object", properties: { agentId: { type: "string" }, question: { type: "string" } }, required: ["agentId", "question"] } },
  ];
  if (hasGithub) {
    allDeclarations.push(
      { name: "github_get_user", description: "Get the authenticated GitHub user info", parameters: { type: "object", properties: {} } },
      { name: "github_list_repos", description: "List the user's GitHub repositories", parameters: { type: "object", properties: {} } },
      { name: "github_create_repo", description: "Create a new GitHub repository", parameters: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, private: { type: "boolean" }, auto_init: { type: "boolean" } }, required: ["name"] } },
      { name: "github_get_repo", description: "Get info about a GitHub repository", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } },
      { name: "github_create_or_update_file", description: "Create or update a file in a GitHub repository", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" }, content: { type: "string" }, message: { type: "string" }, branch: { type: "string" } }, required: ["owner", "repo", "path", "content", "message"] } },
      { name: "github_create_branch", description: "Create a new branch", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, branch: { type: "string" } }, required: ["owner", "repo", "branch"] } },
      { name: "github_list_files", description: "List files in a repository directory", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" } }, required: ["owner", "repo"] } },
      { name: "github_list_issues", description: "List open issues in a repository", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } },
      { name: "github_create_issue", description: "Create a new GitHub issue", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["owner", "repo", "title"] } },
    );
  }
  return [{ functionDeclarations: allDeclarations }];
}

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
    const baseUrl = process.env.APP_URL || "https://prox-two-zeta.vercel.app";
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 28_000);
    const res = await fetch(`${baseUrl}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: question, agentId: targetId, history: [], githubToken, _depth: depth + 1 }),
      signal: controller.signal,
    });
    clearTimeout(tid);
    const data = await res.json();
    return data.text || "[нет ответа]";
  } catch (e) {
    return `[ошибка консультации: ${String(e).slice(0, 100)}]`;
  }
}

export async function GET() {
  const now = Date.now();
  return NextResponse.json({
    version: 11,
    pool: MODEL_POOL.map(m => ({
      id: m.id, model: m.model,
      available: (cooldowns.get(m.id) ?? 0) <= now,
      cooldownUntil: cooldowns.get(m.id) ? new Date(cooldowns.get(m.id)!).toISOString() : null,
    })),
    groqConfigured: !!groq,
    openrouterConfigured: !!process.env.OPENROUTER_API_KEY,
    cerebrasConfigured: !!cerebrasKey,
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
    const sharedRepo = process.env.SHARED_GITHUB_REPO || "";
    const githubInstruction = hasGithub
      ? (sharedRepo
        ? `\n\nGITHUB (СТРОГО): у команды ОДИН общий репозиторий — ${sharedRepo}. НИКОГДА не создавай новые репозитории. Все файлы пиши только в ${sharedRepo} через github_create_or_update_file. owner — первая часть до "/", repo — вторая.\n\nЧТО ПИСАТЬ В РЕПО: ТОЛЬКО реальный рабочий код — .ts/.tsx/.js/.py/.css/конфиги. README.md создавай только если явно попросили. Сразу пиши минимум 2-3 файла с реальным кодом по своей специальности.`
        : "\n\nGITHUB (СТРОГО): у команды ОДИН общий репозиторий. Имя репо будет в тексте задачи (формат: nikidav9/repo-name). Используй его. НИКОГДА не создавай новые репозитории.\n\nЧТО ПИСАТЬ В РЕПО: ТОЛЬКО реальный рабочий код — .ts/.tsx/.js/.py/.css/конфиги. README.md НЕ НУЖЕН если не просили. Сразу пиши реальный код по своей специальности.")
      : "";
    const systemInstruction = agent.soul
      + "\n\nПРАВИЛА ОТВЕТА (СТРОГО): пиши максимум 1-2 предложения. Никаких вступлений, никаких 'конечно', никаких списков. Только суть."
      + `\n\nДЕЛЕГИРОВАНИЕ ЗАДАЧ: если нужно поставить задачу коллеге, добавь маркер в конце ответа:\n[TASK:agentId:краткое описание задачи]\nПример: [TASK:frontend:Сделать форму регистрации]\nМожно несколько маркеров подряд. Список агентов:\n${agentList}`
      + githubInstruction;

    const stored: ChatMsg[] = await loadHistory(agentId);
    const fullHistory: ChatMsg[] = stored.length > 0 ? stored : (history || []);
    const compressedHistory = await compressHistory(fullHistory);
    const userMsg: ChatMsg = { role: "user", text: message, ts: Date.now() };
    await saveHistory(agentId, [...compressedHistory, userMsg]);

    const trimmedHistory = compressedHistory.filter(m => m.role === "user" || m.role === "model");
    const groqHistory = compressedHistory.filter(m => m.role === "user" || m.role === "model")
      .map(m => ({ role: (m.role === "model" ? "assistant" : "user") as "user" | "assistant", content: m.text }));

    let text = "";
    const githubActions: string[] = [];
    let lastError = "";
    let usedProvider = "";

    // Per-model timeout to prevent Vercel 60s limit
    function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
      return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
      ]);
    }

    // Build shared message format for OR/Groq/Cerebras
    const chatMessages = [
      { role: "system", content: systemInstruction },
      ...groqHistory,
      { role: "user", content: message },
    ];
    const chatTools = buildGroqTools(hasGithub);

    // Helper: call any OpenAI-compatible endpoint
    async function callOpenAICompat(
      url: string, authHeader: string, entry: ModelEntry,
      messages: object[], tools: object[], timeoutMs: number, extraHeaders?: Record<string,string>
    ) {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Authorization": authHeader, "Content-Type": "application/json", ...extraHeaders },
          body: JSON.stringify({ model: entry.model, messages, max_tokens: 400, tools, tool_choice: "auto" }),
          signal: controller.signal,
        });
        clearTimeout(tid);
        const data = await res.json() as { choices?: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[]; error?: { message: string } };
        if (data.error) throw new Error(data.error.message);
        const msg = data.choices?.[0]?.message;
        if (!msg?.content && !msg?.tool_calls?.length) throw new Error("Empty response");
        return { msg, entry };
      } finally { clearTimeout(tid); }
    }

    // Sequential failover: one model at a time, instant skip on quota/error
    // rotatedModels() distributes load evenly — each request starts from different model
    const fastPool = rotatedModels().filter(e => e.provider === "openrouter" || e.provider === "cerebras");
    let raceResult: Awaited<ReturnType<typeof callOpenAICompat>> | null = null;
    for (const entry of fastPool) {
      try {
        if (entry.provider === "openrouter" && process.env.OPENROUTER_API_KEY) {
          raceResult = await callOpenAICompat(
            "https://openrouter.ai/api/v1/chat/completions",
            `Bearer ${process.env.OPENROUTER_API_KEY}`,
            entry, chatMessages, chatTools, 18_000,
            { "HTTP-Referer": "https://prox-two-zeta.vercel.app", "X-Title": "Dev Office" }
          );
        } else if (entry.provider === "cerebras" && cerebrasKey) {
          raceResult = await callOpenAICompat(
            "https://api.cerebras.ai/v1/chat/completions",
            `Bearer ${cerebrasKey}`,
            entry, chatMessages, chatTools, 12_000
          );
        } else { continue; }
        break;
      } catch (e) { markCooled(entry.id, String(e)); continue; }
    }

    const orMessages = chatMessages;
    const orTools = chatTools;
    if (fastPool.length > 0) {

      if (raceResult) {
        const { msg, entry } = raceResult;
        let curMessages = [...orMessages];
        let curMsg = msg;
        // Process tool calls in follow-up rounds
        for (let round = 0; round < 5 && curMsg.tool_calls?.length; round++) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          curMessages.push({ role: "assistant", content: curMsg.content ?? "", ...(curMsg.tool_calls ? { tool_calls: curMsg.tool_calls } : {}) } as any);
          for (const tc of curMsg.tool_calls) {
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            curMessages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(toolResult), name: tc.function.name } as any);
          }
          try {
            const followUrl = entry.provider === "cerebras"
              ? "https://api.cerebras.ai/v1/chat/completions"
              : "https://openrouter.ai/api/v1/chat/completions";
            const followAuth = entry.provider === "cerebras"
              ? `Bearer ${cerebrasKey}`
              : `Bearer ${process.env.OPENROUTER_API_KEY}`;
            const followExtra: Record<string,string> = entry.provider === "openrouter"
              ? { "HTTP-Referer": "https://prox-two-zeta.vercel.app", "X-Title": "Dev Office" } : {};
            const r2 = await callOpenAICompat(followUrl, followAuth, entry, curMessages, orTools, 15_000, followExtra);
            curMsg = r2.msg;
          } catch { break; }
        }
        text = curMsg.content || "";
        usedProvider = entry.id;
      } else {
        fastPool.forEach(e => markCooled(e.id, "all failed"));
      }
    }

    // Fallback: sequential Groq / Gemini if race didn't produce text
    const fallbackPool = text ? [] : availableModels().filter(e => e.provider !== "openrouter" && e.provider !== "cerebras");
    for (const entry of fallbackPool) {
      const modelTimeout = entry.provider === "gemini" ? 10_000 : 8_000;
      try {
        if (entry.provider === "gemini") {
          const gModel = genAI.getGenerativeModel({
            model: entry.model, systemInstruction,
            tools: buildGeminiTools(hasGithub),
          });
          const chat = gModel.startChat({
            history: trimmedHistory.map(msg => ({ role: msg.role, parts: [{ text: msg.text }] })),
          });
          let result = await withTimeout(
            chat.sendMessage(message, { generationConfig: { maxOutputTokens: 800 } } as never),
            modelTimeout
          );
          for (let i = 0; i < 8; i++) {
            const parts = result.response.candidates?.[0]?.content?.parts ?? [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const calls = parts.filter((p: any) => p.functionCall);
            if (calls.length === 0) break;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const responses = await Promise.all(calls.map(async (part: any) => {
              const fc = part.functionCall!;
              let toolResult: object;
              if (fc.name === "consult_agent") {
                const args = fc.args as Record<string,unknown>;
                const reply = await consultAgent(String(args.agentId), String(args.question), githubToken, _depth);
                toolResult = { reply };
                githubActions.push(`👥 ${args.agentId}: ${reply.slice(0, 120)}`);
              } else {
                toolResult = await runGithubTool(fc.name, fc.args as Record<string,unknown>, githubToken);
                githubActions.push(`${fc.name}: ${JSON.stringify(toolResult).slice(0, 150)}`);
              }
              return { functionResponse: { name: fc.name, response: toolResult } };
            }));
            result = await withTimeout(
              chat.sendMessage(responses as Parameters<typeof chat.sendMessage>[0], { generationConfig: { maxOutputTokens: 800 } } as never),
              modelTimeout
            );
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
            const groqRes = await withTimeout(groq.chat.completions.create({
              model: entry.model, messages: groqMessages,
              max_tokens: 600, tools: groqTools, tool_choice: "auto",
            }), modelTimeout);
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

    // Some models write consult_agent as plain text in various formats.
    // Detect and execute them, then clean the output.
    const inlineCalls: { agentId: string; question: string }[] = [];
    const seenCalls = new Set<string>();
    const addCall = (aid: string, q: string) => {
      const key = `${aid}:${q}`;
      if (!seenCalls.has(key) && AGENTS.find(a=>a.id===aid)) { seenCalls.add(key); inlineCalls.push({ agentId: aid, question: q }); }
    };
    // Format 1: consult_agent(id, "q") | consult_agent(id="q")
    const re1 = /consult_agent\s*\(\s*["']?([\w-]+)["']?\s*[=,]\s*["'`]?([\s\S]+?)["'`]?\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re1.exec(text)) !== null) addCall(m[1], m[2]);
    // Format 2: function=consult_agent>{"agentId":"...","question":"..."}
    const re2 = /(?:function=consult_agent|consult_agent)[>\s]*(\{[^}]+\})/g;
    while ((m = re2.exec(text)) !== null) {
      try { const o = JSON.parse(m[1]); if (o.agentId && o.question) addCall(String(o.agentId), String(o.question)); } catch {}
    }
    // Parse [TASK:agentId:description] markers (explicit delegation format, no tool calls needed)
    const taskMarkerRe = /\[TASK:([\w-]+):([^\]]+)\]/g;
    let tm: RegExpExecArray | null;
    while ((tm = taskMarkerRe.exec(text)) !== null) {
      addCall(tm[1], tm[2].trim());
    }

    if (inlineCalls.length > 0) {
      // Save tasks directly to agents' Supabase histories as user messages.
      // The frontend auto-resumes chats that end with a user message, so the agents will respond naturally.
      await Promise.all(inlineCalls.map(async ({ agentId: tId, question }) => {
        const existing = await loadHistory(tId);
        await saveHistory(tId, [...existing, { role: "user", text: question }]);
        githubActions.push(`👥 ${tId}: ${question.slice(0, 100)}`);
      }));
      // Strip all agent-call syntax from displayed text
      text = text
        .replace(/\[TASK:[\w-]+:[^\]]+\]\s*/g, "")
        .replace(/consult_agent\s*\([^)]*\)\s*/g, "")
        .replace(/(?:function=consult_agent|<function=consult_agent)[^\n]*(?:\n|$)/g, "")
        .replace(/<\/function>\s*/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    const botMsg: ChatMsg = { role: "model", text, ts: Date.now(), ...(githubActions.length ? { githubActions } : {}) };
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
