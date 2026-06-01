import { GoogleGenerativeAI, Tool, SchemaType } from "@google/generative-ai";
import Groq from "groq-sdk";
import { NextRequest, NextResponse } from "next/server";
import { AGENTS } from "@/lib/agents";
import { loadHistory, saveHistory, ChatMsg } from "@/lib/supabase";

export const maxDuration = 60;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

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
      case "github_get_user":
        return await githubFetch(token, "/user");
      case "github_list_repos":
        return await githubFetch(token, "/user/repos?per_page=20&sort=updated");
      case "github_create_repo":
        return await githubFetch(token, "/user/repos", "POST", {
          name: args.name, description: args.description ?? "",
          private: args.private ?? false, auto_init: args.auto_init ?? true,
        });
      case "github_get_repo":
        return await githubFetch(token, `/repos/${args.owner}/${args.repo}`);
      case "github_create_or_update_file": {
        const content = Buffer.from(String(args.content)).toString("base64");
        let sha: string | undefined;
        try {
          const ex = await githubFetch(token, `/repos/${args.owner}/${args.repo}/contents/${args.path}`);
          if ((ex as Record<string,unknown>).sha) sha = (ex as Record<string,unknown>).sha as string;
        } catch {}
        return await githubFetch(token, `/repos/${args.owner}/${args.repo}/contents/${args.path}`, "PUT", {
          message: args.message ?? "Update file", content,
          ...(sha ? { sha } : {}),
          branch: args.branch ?? "main",
        });
      }
      case "github_create_branch": {
        const repo = await githubFetch(token, `/repos/${args.owner}/${args.repo}`) as Record<string,unknown>;
        const ref = await githubFetch(token, `/repos/${args.owner}/${args.repo}/git/refs/heads/${repo.default_branch ?? "main"}`) as Record<string,unknown>;
        return await githubFetch(token, `/repos/${args.owner}/${args.repo}/git/refs`, "POST", {
          ref: `refs/heads/${args.branch}`, sha: (ref.object as Record<string,unknown>)?.sha,
        });
      }
      case "github_list_issues":
        return await githubFetch(token, `/repos/${args.owner}/${args.repo}/issues?state=open`);
      case "github_create_issue":
        return await githubFetch(token, `/repos/${args.owner}/${args.repo}/issues`, "POST", {
          title: args.title, body: args.body ?? "", labels: args.labels ?? [],
        });
      case "github_list_files":
        return await githubFetch(token, `/repos/${args.owner}/${args.repo}/contents/${args.path ?? ""}`);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: String(err) };
  }
}

const CONSULT_TOOL: Tool = {
  functionDeclarations: [{
    name: "consult_agent",
    description: "Ask a colleague agent a specific question and get their expert answer",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        agentId: { type: SchemaType.STRING, description: "Agent ID to consult (e.g. frontend, backend, devops)" },
        question: { type: SchemaType.STRING, description: "Specific question for the agent" },
      },
      required: ["agentId", "question"],
    },
  }],
};

const GITHUB_TOOLS: Tool[] = [{
  functionDeclarations: [
    {
      name: "github_get_user",
      description: "Get the authenticated GitHub user info (login, name)",
      parameters: { type: SchemaType.OBJECT, properties: {} },
    },
    {
      name: "github_list_repos",
      description: "List the user's GitHub repositories",
      parameters: { type: SchemaType.OBJECT, properties: {} },
    },
    {
      name: "github_create_repo",
      description: "Create a new GitHub repository",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          name: { type: SchemaType.STRING, description: "Repo name (no spaces, use hyphens)" },
          description: { type: SchemaType.STRING },
          private: { type: SchemaType.BOOLEAN },
          auto_init: { type: SchemaType.BOOLEAN, description: "Initialize with README" },
        },
        required: ["name"],
      },
    },
    {
      name: "github_get_repo",
      description: "Get info about a GitHub repository",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          owner: { type: SchemaType.STRING },
          repo: { type: SchemaType.STRING },
        },
        required: ["owner", "repo"],
      },
    },
    {
      name: "github_create_or_update_file",
      description: "Create or update a file in a GitHub repository",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          owner: { type: SchemaType.STRING },
          repo: { type: SchemaType.STRING },
          path: { type: SchemaType.STRING, description: "File path e.g. src/index.ts" },
          content: { type: SchemaType.STRING, description: "Full file content as plain text" },
          message: { type: SchemaType.STRING, description: "Commit message" },
          branch: { type: SchemaType.STRING, description: "Branch name, default main" },
        },
        required: ["owner", "repo", "path", "content", "message"],
      },
    },
    {
      name: "github_create_branch",
      description: "Create a new branch in a repository",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          owner: { type: SchemaType.STRING },
          repo: { type: SchemaType.STRING },
          branch: { type: SchemaType.STRING, description: "New branch name" },
        },
        required: ["owner", "repo", "branch"],
      },
    },
    {
      name: "github_list_files",
      description: "List files in a repository directory",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          owner: { type: SchemaType.STRING },
          repo: { type: SchemaType.STRING },
          path: { type: SchemaType.STRING, description: "Directory path, empty for root" },
        },
        required: ["owner", "repo"],
      },
    },
    {
      name: "github_list_issues",
      description: "List open issues in a repository",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          owner: { type: SchemaType.STRING },
          repo: { type: SchemaType.STRING },
        },
        required: ["owner", "repo"],
      },
    },
    {
      name: "github_create_issue",
      description: "Create a new GitHub issue",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          owner: { type: SchemaType.STRING },
          repo: { type: SchemaType.STRING },
          title: { type: SchemaType.STRING },
          body: { type: SchemaType.STRING },
          labels: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        },
        required: ["owner", "repo", "title"],
      },
    },
  ],
}];

// Call another agent and get their response (depth-limited to prevent loops)
async function consultAgent(targetId: string, question: string, githubToken: string, depth: number): Promise<string> {
  if (depth >= 2) return "[максимальная глубина цепочки достигнута]";
  const target = AGENTS.find(a => a.id === targetId);
  if (!target) return `[агент ${targetId} не найден]`;
  try {
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000";
    const res = await fetch(`${baseUrl}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: question, agentId: targetId, history: [], githubToken, _depth: depth + 1 }),
    });
    const data = await res.json();
    return data.text || "[нет ответа]";
  } catch {
    return "[ошибка консультации]";
  }
}

export async function POST(req: NextRequest) {
  try {
    const { message, agentId, history, githubToken: clientToken, _depth = 0 } = await req.json();
    if (!message || !agentId)
      return NextResponse.json({ error: "message and agentId required" }, { status: 400 });

    const agent = AGENTS.find((a) => a.id === agentId);
    if (!agent)
      return NextResponse.json({ error: "Unknown agent" }, { status: 400 });

    const githubToken = clientToken?.trim() || process.env.GITHUB_TOKEN || "";
    const hasGithub = !!githubToken;

    const agentList = AGENTS.map(a => `${a.id} — ${a.name} (${a.role})`).join("\n");
    const systemInstruction = agent.soul
      + (hasGithub ? "\n\nУ тебя есть доступ к GitHub через инструменты. Делай сразу через инструменты, сначала вызывай github_get_user." : "")
      + `\n\nТЫ МОЖЕШЬ КОНСУЛЬТИРОВАТЬСЯ С КОЛЛЕГАМИ через инструмент consult_agent.\nСписок агентов:\n${agentList}\nИспользуй когда задача явно требует экспертизы другого специалиста. Передавай конкретный вопрос, не весь контекст.`;

    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction,
      ...({ tools: [...GITHUB_TOOLS, CONSULT_TOOL] }),
    });

    const chat = model.startChat({
      history: (history || []).map((msg: { role: string; text: string }) => ({
        role: msg.role,
        parts: [{ text: msg.text }],
      })),
    });

    // Auto-retry on rate limit (429) — wait the time Gemini specifies, then retry
    async function sendWithRetry(payload: Parameters<typeof chat.sendMessage>[0]) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await chat.sendMessage(payload);
        } catch (err) {
          const msg = String(err);
          const match = msg.match(/retry in ([\d.]+)s/i);
          const waitMs = match ? Math.ceil(parseFloat(match[1]) * 1000) : 15_000;
          if (attempt < 2 && waitMs <= 25_000) {
            await new Promise(r => setTimeout(r, waitMs));
          } else throw err;
        }
      }
      throw new Error("Max retries exceeded");
    }

    let text = "";
    const githubActions: string[] = [];
    let usedGroq = false;

    try {
      let result = await sendWithRetry(message);

      for (let i = 0; i < 8; i++) {
        const parts = result.response.candidates?.[0]?.content?.parts ?? [];
        const calls = parts.filter((p) => p.functionCall);
        if (calls.length === 0) break;

        const responses = await Promise.all(
          calls.map(async (part) => {
            const fc = part.functionCall!;
            let toolResult: object;
            if (fc.name === "consult_agent") {
              const args = fc.args as Record<string, unknown>;
              const reply = await consultAgent(String(args.agentId), String(args.question), githubToken, _depth);
              toolResult = { reply };
              githubActions.push(`👥 ${args.agentId}: ${reply.slice(0, 120)}`);
            } else {
              toolResult = await runGithubTool(fc.name, fc.args as Record<string, unknown>, githubToken);
              githubActions.push(`${fc.name}: ${JSON.stringify(toolResult).slice(0, 150)}`);
            }
            return { functionResponse: { name: fc.name, response: toolResult } };
          })
        );
        result = await sendWithRetry(responses as Parameters<typeof chat.sendMessage>[0]);
      }

      text = result.response.text();
    } catch (geminiErr) {
      const geminiMsg = String(geminiErr);
      const isQuota = geminiMsg.includes("429") || geminiMsg.includes("quota") || geminiMsg.includes("RESOURCE_EXHAUSTED");

      if (isQuota && groq) {
        usedGroq = true;
        const groqHistory = (history || []).map((m: { role: string; text: string }) => ({
          role: (m.role === "model" ? "assistant" : "user") as "user" | "assistant",
          content: m.text,
        }));

        // Tools for Groq (GitHub + consult_agent)
        const groqTools = [
          { type: "function" as const, function: { name: "consult_agent", description: "Ask a colleague agent", parameters: { type: "object", properties: { agentId: { type: "string", description: `Agent ID, one of: ${AGENTS.map(a=>a.id).join(", ")}` }, question: { type: "string" } }, required: ["agentId","question"] } } },
          ...(hasGithub ? [
          { type: "function" as const, function: { name: "github_get_user", description: "Get authenticated GitHub user", parameters: { type: "object", properties: {} } } },
          { type: "function" as const, function: { name: "github_list_repos", description: "List user repos", parameters: { type: "object", properties: {} } } },
          { type: "function" as const, function: { name: "github_create_repo", description: "Create a new repo", parameters: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, private: { type: "boolean" }, auto_init: { type: "boolean" } }, required: ["name"] } } },
          { type: "function" as const, function: { name: "github_create_or_update_file", description: "Create or update file in repo", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" }, content: { type: "string" }, message: { type: "string" }, branch: { type: "string" } }, required: ["owner", "repo", "path", "content", "message"] } } },
          { type: "function" as const, function: { name: "github_create_branch", description: "Create a branch", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, branch: { type: "string" } }, required: ["owner", "repo", "branch"] } } },
          { type: "function" as const, function: { name: "github_list_files", description: "List files in repo", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" } }, required: ["owner", "repo"] } } },
          { type: "function" as const, function: { name: "github_list_issues", description: "List open issues", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } } },
          { type: "function" as const, function: { name: "github_create_issue", description: "Create an issue", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["owner", "repo", "title"] } } },
        ] : [])];

        const groqMessages: Groq.Chat.ChatCompletionMessageParam[] = [
          { role: "system", content: systemInstruction },
          ...groqHistory,
          { role: "user", content: message },
        ];

        // Tool-calling loop for Groq (max 6 rounds)
        for (let round = 0; round < 6; round++) {
          const groqRes = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: groqMessages,
            max_tokens: 1024,
            tools: groqTools,
            tool_choice: "auto",
          });
          const choice = groqRes.choices[0];
          const msg = choice.message;
          groqMessages.push(msg as Groq.Chat.ChatCompletionMessageParam);

          if (!msg.tool_calls || msg.tool_calls.length === 0) {
            text = msg.content || "Нет ответа";
            break;
          }

          // Execute each tool call
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
            groqMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify(toolResult),
            });
          }
        }
      } else {
        throw geminiErr;
      }
    }

    // Persist to Supabase
    const stored: ChatMsg[] = await loadHistory(agentId);
    const userMsg: ChatMsg = { role: "user", text: message };
    const botMsg: ChatMsg = { role: "model", text, ...(githubActions.length ? { githubActions } : {}) };
    await saveHistory(agentId, [...stored, userMsg, botMsg]);

    return NextResponse.json({
      text,
      agentName: agent.name,
      githubActions: githubActions.length ? githubActions : undefined,
      ...(usedGroq ? { provider: "groq" } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Agent error:", msg);
    const retryMatch = msg.match(/retry in ([\d.]+)s/i);
    const retryAfter = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : null;
    return NextResponse.json({ error: msg, retryAfter }, { status: retryAfter ? 429 : 500 });
  }
}
