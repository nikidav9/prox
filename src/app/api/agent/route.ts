import { GoogleGenerativeAI, Tool, SchemaType } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";
import { AGENTS } from "@/lib/agents";
import { loadHistory, saveHistory, ChatMsg } from "@/lib/supabase";

export const maxDuration = 60;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

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

export async function POST(req: NextRequest) {
  try {
    const { message, agentId, history, githubToken: clientToken } = await req.json();
    if (!message || !agentId)
      return NextResponse.json({ error: "message and agentId required" }, { status: 400 });

    const agent = AGENTS.find((a) => a.id === agentId);
    if (!agent)
      return NextResponse.json({ error: "Unknown agent" }, { status: 400 });

    const githubToken = clientToken?.trim() || process.env.GITHUB_TOKEN || "";
    const hasGithub = !!githubToken;
    const systemInstruction = agent.soul +
      (hasGithub
        ? "\n\nУ тебя есть доступ к GitHub через инструменты. Используй их для реальной работы: создавай репозитории, файлы, ветки, задачи. Когда тебя просят что-то сделать в GitHub — делай сразу через инструменты, не просто объясняй. Сначала всегда вызывай github_get_user чтобы знать логин пользователя."
        : "");

    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction,
      ...(hasGithub ? { tools: GITHUB_TOOLS } : {}),
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

    let result = await sendWithRetry(message);
    const githubActions: string[] = [];

    for (let i = 0; i < 6 && hasGithub; i++) {
      const parts = result.response.candidates?.[0]?.content?.parts ?? [];
      const calls = parts.filter((p) => p.functionCall);
      if (calls.length === 0) break;

      const responses = await Promise.all(
        calls.map(async (part) => {
          const fc = part.functionCall!;
          const toolResult = await runGithubTool(fc.name, fc.args as Record<string, unknown>, githubToken);
          const summary = JSON.stringify(toolResult);
          githubActions.push(`${fc.name}: ${summary.slice(0, 150)}`);
          return { functionResponse: { name: fc.name, response: toolResult } };
        })
      );
      result = await sendWithRetry(responses as Parameters<typeof chat.sendMessage>[0]);
    }

    const text = result.response.text();

    // Persist to Redis so history survives browser close
    const stored: ChatMsg[] = await loadHistory(agentId);
    const userMsg: ChatMsg = { role: "user", text: message };
    const botMsg: ChatMsg = { role: "model", text, ...(githubActions.length ? { githubActions } : {}) };
    await saveHistory(agentId, [...stored, userMsg, botMsg]);

    return NextResponse.json({ text, agentName: agent.name, githubActions: githubActions.length ? githubActions : undefined });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Agent error:", msg);
    const retryMatch = msg.match(/retry in ([\d.]+)s/i);
    const retryAfter = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : null;
    return NextResponse.json({ error: msg, retryAfter }, { status: retryAfter ? 429 : 500 });
  }
}
