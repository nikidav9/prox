import { GoogleGenerativeAI, Tool } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";
import { AGENTS } from "@/lib/agents";

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

async function runGithubTool(name: string, args: Record<string, unknown>, token: string): Promise<unknown> {
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
          if (ex.sha) sha = ex.sha as string;
        } catch {}
        return await githubFetch(token, `/repos/${args.owner}/${args.repo}/contents/${args.path}`, "PUT", {
          message: args.message ?? "Update file", content,
          ...(sha ? { sha } : {}),
          branch: args.branch ?? "main",
        });
      }
      case "github_create_branch": {
        const repo = await githubFetch(token, `/repos/${args.owner}/${args.repo}`);
        const ref = await githubFetch(token, `/repos/${args.owner}/${args.repo}/git/refs/heads/${repo.default_branch ?? "main"}`);
        return await githubFetch(token, `/repos/${args.owner}/${args.repo}/git/refs`, "POST", {
          ref: `refs/heads/${args.branch}`, sha: ref.object?.sha,
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
      parameters: { type: "object" as const, properties: {} },
    },
    {
      name: "github_list_repos",
      description: "List the user's GitHub repositories",
      parameters: { type: "object" as const, properties: {} },
    },
    {
      name: "github_create_repo",
      description: "Create a new GitHub repository",
      parameters: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const, description: "Repo name (no spaces, use hyphens)" },
          description: { type: "string" as const },
          private: { type: "boolean" as const },
          auto_init: { type: "boolean" as const, description: "Initialize with README" },
        },
        required: ["name"],
      },
    },
    {
      name: "github_get_repo",
      description: "Get info about a GitHub repository",
      parameters: {
        type: "object" as const,
        properties: {
          owner: { type: "string" as const },
          repo: { type: "string" as const },
        },
        required: ["owner", "repo"],
      },
    },
    {
      name: "github_create_or_update_file",
      description: "Create or update a file in a GitHub repository",
      parameters: {
        type: "object" as const,
        properties: {
          owner: { type: "string" as const },
          repo: { type: "string" as const },
          path: { type: "string" as const, description: "File path e.g. src/index.ts" },
          content: { type: "string" as const, description: "Full file content as plain text" },
          message: { type: "string" as const, description: "Commit message" },
          branch: { type: "string" as const, description: "Branch name, default main" },
        },
        required: ["owner", "repo", "path", "content", "message"],
      },
    },
    {
      name: "github_create_branch",
      description: "Create a new branch in a repository",
      parameters: {
        type: "object" as const,
        properties: {
          owner: { type: "string" as const },
          repo: { type: "string" as const },
          branch: { type: "string" as const, description: "New branch name" },
        },
        required: ["owner", "repo", "branch"],
      },
    },
    {
      name: "github_list_files",
      description: "List files in a repository directory",
      parameters: {
        type: "object" as const,
        properties: {
          owner: { type: "string" as const },
          repo: { type: "string" as const },
          path: { type: "string" as const, description: "Directory path, empty for root" },
        },
        required: ["owner", "repo"],
      },
    },
    {
      name: "github_list_issues",
      description: "List open issues in a repository",
      parameters: {
        type: "object" as const,
        properties: {
          owner: { type: "string" as const },
          repo: { type: "string" as const },
        },
        required: ["owner", "repo"],
      },
    },
    {
      name: "github_create_issue",
      description: "Create a new GitHub issue",
      parameters: {
        type: "object" as const,
        properties: {
          owner: { type: "string" as const },
          repo: { type: "string" as const },
          title: { type: "string" as const },
          body: { type: "string" as const },
          labels: { type: "array" as const, items: { type: "string" as const } },
        },
        required: ["owner", "repo", "title"],
      },
    },
  ],
}];

export async function POST(req: NextRequest) {
  try {
    const { message, agentId, history, githubToken } = await req.json();
    if (!message || !agentId)
      return NextResponse.json({ error: "message and agentId required" }, { status: 400 });

    const agent = AGENTS.find((a) => a.id === agentId);
    if (!agent)
      return NextResponse.json({ error: "Unknown agent" }, { status: 400 });

    const hasGithub = !!(githubToken?.trim());
    const systemInstruction = agent.soul +
      (hasGithub
        ? "\n\nУ тебя есть доступ к GitHub через инструменты. Используй их для реальной работы: создавай репозитории, файлы, ветки, задачи. Когда тебя просят что-то сделать в GitHub — делай сразу через инструменты, не просто объясняй. Сначала всегда вызывай github_get_user чтобы знать логин пользователя."
        : "");

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
      systemInstruction,
      ...(hasGithub ? { tools: GITHUB_TOOLS } : {}),
    });

    const chat = model.startChat({
      history: (history || []).map((msg: { role: string; text: string }) => ({
        role: msg.role,
        parts: [{ text: msg.text }],
      })),
    });

    let result = await chat.sendMessage(message);
    const githubActions: string[] = [];

    // Function calling loop (max 6 rounds)
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
      result = await chat.sendMessage(responses);
    }

    const text = result.response.text();
    return NextResponse.json({ text, agentName: agent.name, githubActions: githubActions.length ? githubActions : undefined });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Agent error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
