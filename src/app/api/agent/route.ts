import { GoogleGenerativeAI, Tool, SchemaType } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";
import { AGENTS } from "@/lib/agents";
import { loadHistory, saveHistory, acquireDispatchLock, releaseDispatchLock, ChatMsg, loadCooldowns, saveCooldowns, loadProjectRepo, saveProjectRepo } from "@/lib/supabase";
import { sendTelegram, getTelegramChatId, getGroupInfo } from "@/app/api/telegram/route";

export const maxDuration = 60;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

type Provider = "gemini";
interface ModelEntry { id: string; provider: Provider; model: string }

const MODEL_POOL: ModelEntry[] = [
  { id: "gemini-2.5-flash",      provider: "gemini", model: "gemini-2.5-flash" },
  { id: "gemini-2.5-flash-lite", provider: "gemini", model: "gemini-2.5-flash-lite" },
  { id: "gemini-flash-latest",   provider: "gemini", model: "gemini-flash-latest" },
];

const cooldowns = new Map<string, number>();
let roundRobinIdx = 0;
let cooldownsLoaded = false;

async function ensureCooldownsLoaded() {
  if (cooldownsLoaded) return;
  cooldownsLoaded = true;
  const data = await loadCooldowns();
  const now = Date.now();
  for (const [id, until] of Object.entries(data)) {
    if (until > now) cooldowns.set(id, until);
  }
}

async function persistCooldown(id: string, until: number) {
  cooldowns.set(id, until);
  const snapshot: Record<string, number> = {};
  cooldowns.forEach((v, k) => { if (v > Date.now()) snapshot[k] = v; });
  await saveCooldowns(snapshot);
}

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

async function markCooled(id: string, msg: string) {
  const secMatch = msg.match(/try again in ([\d.]+)s/i) || msg.match(/retry in ([\d.]+)s/i);
  const minMatch = msg.match(/try again in (\d+)m/i);
  const isQuota = msg.includes("quota") || msg.includes("429") || msg.includes("rate") || msg.includes("limit");
  const waitMs = secMatch ? Math.ceil(parseFloat(secMatch[1]) * 1000)
    : minMatch ? parseInt(minMatch[1]) * 60_000
    : isQuota ? 60_000 : 15_000;
  const until = Date.now() + Math.min(waitMs + 5000, 24 * 3600_000);
  await persistCooldown(id, until);
}

async function compressHistory(messages: ChatMsg[]): Promise<ChatMsg[]> {
  return messages;
}

// Strip internal reasoning blocks that thinking models expose
function stripThinking(text: string): string {
  // Remove <think>...</think> blocks (DeepSeek-R1, Qwen3, etc.)
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // Remove <thinking>...</thinking>
  text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  // Remove [思考过程] Chinese thinking markers
  text = text.replace(/\[思考过程\][\s\S]*?\[\/思考过程\]/g, "");
  return text.trim();
}

// Returns true if response is predominantly English (model ignored Russian instruction)
function isEnglishResponse(text: string): boolean {
  if (!text || text.length < 20) return false;
  const cyrillic = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  // If less than 10% Cyrillic and more than 40 Latin chars — it's English
  return latin > 40 && cyrillic < latin * 0.1;
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
      case "github_create_repo": {
        const result = await githubFetch(token, "/user/repos", "POST", {
          name: args.name, description: args.description ?? "", private: args.private ?? false, auto_init: args.auto_init ?? true,
        }) as Record<string, unknown>;
        // Автоматически сохраняем новое репо как текущий проект
        if (result.full_name) await saveProjectRepo(String(result.full_name));
        return result;
      }
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
      case "github_get_file": {
        const res = await githubFetch(token, `/repos/${args.owner}/${args.repo}/contents/${args.path}`) as Record<string,unknown>;
        const content = res.content ? Buffer.from(String(res.content).replace(/\n/g,""), "base64").toString("utf-8") : "";
        return { ...res, decoded_content: content.slice(0, 4000) };
      }
      case "github_delete_file": {
        const ex = await githubFetch(token, `/repos/${args.owner}/${args.repo}/contents/${args.path}`) as Record<string,unknown>;
        return await githubFetch(token, `/repos/${args.owner}/${args.repo}/contents/${args.path}`, "DELETE", {
          message: args.message ?? "Delete file", sha: ex.sha, branch: args.branch ?? "main",
        });
      }
      case "github_create_pull_request": return await githubFetch(token, `/repos/${args.owner}/${args.repo}/pulls`, "POST", {
        title: args.title, body: args.body ?? "", head: args.head, base: args.base ?? "main",
      });
      case "github_close_issue": return await githubFetch(token, `/repos/${args.owner}/${args.repo}/issues/${args.issue_number}`, "PATCH", { state: "closed" });
      case "github_add_comment": return await githubFetch(token, `/repos/${args.owner}/${args.repo}/issues/${args.issue_number}/comments`, "POST", { body: args.body });
      case "github_merge_pull_request": return await githubFetch(token, `/repos/${args.owner}/${args.repo}/pulls/${args.pull_number}/merge`, "PUT", {
        commit_title: args.commit_title ?? "Merge pull request", merge_method: args.merge_method ?? "squash",
      });
      case "github_list_pull_requests": return await githubFetch(token, `/repos/${args.owner}/${args.repo}/pulls?state=${args.state ?? "open"}`);
      case "github_list_actions_runs": return await githubFetch(token, `/repos/${args.owner}/${args.repo}/actions/runs?per_page=10`);
      case "github_get_actions_run": return await githubFetch(token, `/repos/${args.owner}/${args.repo}/actions/runs/${args.run_id}`);
      case "github_list_actions_jobs": {
        const run = await githubFetch(token, `/repos/${args.owner}/${args.repo}/actions/runs/${args.run_id}/jobs`) as Record<string,unknown>;
        // Trim job logs to avoid token overflow
        const jobs = ((run.jobs as Record<string,unknown>[]) || []).map(j => ({
          id: j.id, name: j.name, status: j.status, conclusion: j.conclusion,
          steps: ((j.steps as Record<string,unknown>[]) || []).map(s => ({ name: s.name, status: s.status, conclusion: s.conclusion })),
        }));
        return { total_count: run.total_count, jobs };
      }
      case "github_rerun_actions": return await githubFetch(token, `/repos/${args.owner}/${args.repo}/actions/runs/${args.run_id}/rerun`, "POST", {});
      case "github_get_actions_logs": {
        // Returns download URL for logs
        const res = await githubFetch(token, `/repos/${args.owner}/${args.repo}/actions/runs/${args.run_id}/logs`) as Record<string,unknown>;
        return res;
      }
      case "github_list_secrets": return await githubFetch(token, `/repos/${args.owner}/${args.repo}/actions/secrets`);
      case "github_repo_settings": return await githubFetch(token, `/repos/${args.owner}/${args.repo}`);
      // ── Vercel ──────────────────────────────────────────────────────
      case "vercel_deploy": {
        const vToken = process.env.VERCEL_TOKEN || "";
        if (!vToken) return { error: "VERCEL_TOKEN not set" };
        const ghToken = token;
        const repoFull = String(args.repo ?? args.project_name ?? "prox");
        const [ghOwner, ghRepo] = repoFull.includes("/") ? repoFull.split("/") : ["nikidav9", repoFull];
        // Get GitHub repoId (required by Vercel API)
        let repoId: number | undefined;
        if (ghToken) {
          const ghRes = await githubFetch(ghToken, `/repos/${ghOwner}/${ghRepo}`) as Record<string, unknown>;
          repoId = ghRes.id as number;
        }
        const gitSource = repoId
          ? { type: "github", repoId, ref: args.branch ?? "main" }
          : { type: "github", org: ghOwner, repo: ghRepo, ref: args.branch ?? "main" };
        const projectSettings = {
          framework: (args.framework as string) ?? "nextjs",
          buildCommand: (args.build_command as string) ?? null,
          installCommand: null,
          outputDirectory: null,
          rootDirectory: (args.root_directory as string) ?? null,
          devCommand: null,
        };
        const res = await fetch("https://api.vercel.com/v13/deployments", {
          method: "POST",
          headers: { Authorization: `Bearer ${vToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ name: ghRepo, gitSource, projectSettings }),
        });
        return res.json();
      }
      case "vercel_list_deployments": {
        const vToken = process.env.VERCEL_TOKEN || "";
        const res = await fetch(`https://api.vercel.com/v6/deployments?limit=10${args.project_id ? `&projectId=${args.project_id}` : ""}`, { headers: { Authorization: `Bearer ${vToken}` } });
        return res.json();
      }
      case "vercel_get_deployment": {
        const vToken = process.env.VERCEL_TOKEN || "";
        const res = await fetch(`https://api.vercel.com/v13/deployments/${args.deployment_id}`, { headers: { Authorization: `Bearer ${vToken}` } });
        return res.json();
      }
      case "vercel_list_projects": {
        const vToken = process.env.VERCEL_TOKEN || "";
        const res = await fetch("https://api.vercel.com/v9/projects?limit=20", { headers: { Authorization: `Bearer ${vToken}` } });
        return res.json();
      }
      case "vercel_set_env": {
        const vToken = process.env.VERCEL_TOKEN || "";
        const res = await fetch(`https://api.vercel.com/v10/projects/${args.project_id}/env`, {
          method: "POST", headers: { Authorization: `Bearer ${vToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ key: args.key, value: args.value, type: "encrypted", target: ["production"] }),
        });
        return res.json();
      }
      // ── Supabase ─────────────────────────────────────────────────────
      case "supabase_query": {
        const sbUrl = process.env.SUPABASE_URL || "";
        const sbKey = process.env.SUPABASE_SERVICE_KEY || "";
        if (!sbUrl || !sbKey) return { error: "Supabase not configured" };
        const params = new URLSearchParams();
        if (args.select) params.set("select", String(args.select));
        if (args.filter) params.set(String(args.filter_col ?? "id"), `eq.${args.filter}`);
        if (args.limit) params.set("limit", String(args.limit));
        const res = await fetch(`${sbUrl}/rest/v1/${args.table}?${params}`, {
          headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
        });
        return res.json();
      }
      case "supabase_insert": {
        const sbUrl = process.env.SUPABASE_URL || "";
        const sbKey = process.env.SUPABASE_SERVICE_KEY || "";
        const res = await fetch(`${sbUrl}/rest/v1/${args.table}`, {
          method: "POST",
          headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "Content-Type": "application/json", Prefer: "return=representation" },
          body: JSON.stringify(args.data),
        });
        return res.json();
      }
      case "supabase_update": {
        const sbUrl = process.env.SUPABASE_URL || "";
        const sbKey = process.env.SUPABASE_SERVICE_KEY || "";
        const res = await fetch(`${sbUrl}/rest/v1/${args.table}?${args.filter_col ?? "id"}=eq.${args.filter_val}`, {
          method: "PATCH",
          headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "Content-Type": "application/json", Prefer: "return=representation" },
          body: JSON.stringify(args.data),
        });
        return res.json();
      }
      case "supabase_sql": {
        const sbUrl = process.env.SUPABASE_URL || "";
        const sbKey = process.env.SUPABASE_SERVICE_KEY || "";
        const res = await fetch(`${sbUrl}/rest/v1/rpc/query`, {
          method: "POST",
          headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: args.sql }),
        });
        return res.json();
      }
      // ── Railway ──────────────────────────────────────────────────────
      case "railway_deploy": {
        const rToken = process.env.RAILWAY_TOKEN || "";
        if (!rToken) return { error: "RAILWAY_TOKEN not set" };
        const res = await fetch("https://backboard.railway.app/graphql/v2", {
          method: "POST",
          headers: { Authorization: `Bearer ${rToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: `mutation { serviceInstanceDeploy(serviceId: "${args.service_id}", environmentId: "${args.environment_id}") }` }),
        });
        return res.json();
      }
      case "railway_graphql": {
        const rToken = process.env.RAILWAY_TOKEN || "";
        if (!rToken) return { error: "RAILWAY_TOKEN not set" };
        const res = await fetch("https://backboard.railway.app/graphql/v2", {
          method: "POST",
          headers: { Authorization: `Bearer ${rToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: String(args.query), variables: args.variables ?? {} }),
        });
        return res.json();
      }
      // ── Universal HTTP ────────────────────────────────────────────────
      case "http_request": {
        const method = String(args.method ?? "GET").toUpperCase();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (args.bearer_token) headers["Authorization"] = `Bearer ${args.bearer_token}`;
        if (args.headers && typeof args.headers === "object") Object.assign(headers, args.headers);
        const fetchOpts: RequestInit = { method, headers };
        if (args.body && method !== "GET") fetchOpts.body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
        const res = await fetch(String(args.url), fetchOpts);
        const text = await res.text();
        try { return { status: res.status, data: JSON.parse(text) }; }
        catch { return { status: res.status, data: text.slice(0, 2000) }; }
      }
      default: return { error: `Unknown tool: ${name}` };
    }
  } catch (err) { return { error: String(err) }; }
}

function buildGeminiTools(hasGithub: boolean, isPm = false): Tool[] {
  const agentListStr = AGENTS.map(a => `${a.id} (${a.name})`).join(", ");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allDeclarations: any[] = [
    { name: "consult_agent", description: `Спросить коллегу-агента. Доступные агенты: ${agentListStr}`, parameters: { type: "object", properties: { agentId: { type: "string" }, question: { type: "string" } }, required: ["agentId", "question"] } },
  ];
  if (hasGithub) {
    allDeclarations.push(
      { name: "github_get_user", description: "Get the authenticated GitHub user info", parameters: { type: "object", properties: {} } },
      { name: "github_list_repos", description: "List the user's GitHub repositories", parameters: { type: "object", properties: {} } },
      // Только Лена (pm) может создавать репозиторий
      ...(isPm ? [{ name: "github_create_repo", description: "Создать новый GitHub репозиторий для проекта (только для Лены)", parameters: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, private: { type: "boolean" }, auto_init: { type: "boolean" } }, required: ["name"] } }] : []),
      { name: "github_get_repo", description: "Get info about a GitHub repository", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } },
      { name: "github_create_or_update_file", description: "Create or update a file in a GitHub repository", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" }, content: { type: "string" }, message: { type: "string" }, branch: { type: "string" } }, required: ["owner", "repo", "path", "content", "message"] } },
      { name: "github_create_branch", description: "Create a new branch", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, branch: { type: "string" } }, required: ["owner", "repo", "branch"] } },
      { name: "github_list_files", description: "List files in a repository directory", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" } }, required: ["owner", "repo"] } },
      { name: "github_list_issues", description: "List open issues in a repository", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } },
      { name: "github_create_issue", description: "Create a new GitHub issue", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["owner", "repo", "title"] } },
      { name: "github_get_file", description: "Read file content from a repository", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" } }, required: ["owner", "repo", "path"] } },
      { name: "github_delete_file", description: "Delete a file from a repository", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" }, message: { type: "string" } }, required: ["owner", "repo", "path"] } },
      { name: "github_create_pull_request", description: "Create a pull request", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" }, head: { type: "string" }, base: { type: "string" } }, required: ["owner", "repo", "title", "head"] } },
      { name: "github_list_pull_requests", description: "List open or closed pull requests", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" } }, required: ["owner", "repo"] } },
      { name: "github_merge_pull_request", description: "Merge a pull request", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, pull_number: { type: "number" }, commit_title: { type: "string" }, merge_method: { type: "string" } }, required: ["owner", "repo", "pull_number"] } },
      { name: "github_close_issue", description: "Close a GitHub issue", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "number" } }, required: ["owner", "repo", "issue_number"] } },
      { name: "github_add_comment", description: "Add comment to issue or PR", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "number" }, body: { type: "string" } }, required: ["owner", "repo", "issue_number", "body"] } },
      { name: "github_list_actions_runs", description: "List recent GitHub Actions workflow runs", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } },
      { name: "github_get_actions_run", description: "Get details of a specific Actions run", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, run_id: { type: "number" } }, required: ["owner", "repo", "run_id"] } },
      { name: "github_list_actions_jobs", description: "List jobs and steps of an Actions run", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, run_id: { type: "number" } }, required: ["owner", "repo", "run_id"] } },
      { name: "github_rerun_actions", description: "Re-run a failed GitHub Actions workflow", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, run_id: { type: "number" } }, required: ["owner", "repo", "run_id"] } },
      { name: "github_list_secrets", description: "List GitHub Actions secrets (names only)", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } },
      { name: "github_repo_settings", description: "Get repository settings and info", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } },
      { name: "vercel_deploy", description: "Trigger a Vercel deployment", parameters: { type: "object", properties: { project_name: { type: "string" }, branch: { type: "string" } } } },
      { name: "vercel_list_deployments", description: "List recent Vercel deployments", parameters: { type: "object", properties: { project_id: { type: "string" } } } },
      { name: "vercel_get_deployment", description: "Get Vercel deployment status and details", parameters: { type: "object", properties: { deployment_id: { type: "string" } }, required: ["deployment_id"] } },
      { name: "vercel_list_projects", description: "List all Vercel projects", parameters: { type: "object", properties: {} } },
      { name: "vercel_set_env", description: "Set an environment variable on a Vercel project", parameters: { type: "object", properties: { project_id: { type: "string" }, key: { type: "string" }, value: { type: "string" } }, required: ["project_id", "key", "value"] } },
      { name: "supabase_query", description: "Query a Supabase table", parameters: { type: "object", properties: { table: { type: "string" }, select: { type: "string" }, filter_col: { type: "string" }, filter: { type: "string" }, limit: { type: "number" } }, required: ["table"] } },
      { name: "supabase_insert", description: "Insert a row into a Supabase table", parameters: { type: "object", properties: { table: { type: "string" }, data: { type: "object" } }, required: ["table", "data"] } },
      { name: "supabase_update", description: "Update rows in a Supabase table", parameters: { type: "object", properties: { table: { type: "string" }, filter_col: { type: "string" }, filter_val: { type: "string" }, data: { type: "object" } }, required: ["table", "filter_val", "data"] } },
      { name: "railway_deploy", description: "Trigger a Railway deployment", parameters: { type: "object", properties: { service_id: { type: "string" }, environment_id: { type: "string" } }, required: ["service_id", "environment_id"] } },
      { name: "railway_graphql", description: "Run any Railway GraphQL query or mutation", parameters: { type: "object", properties: { query: { type: "string" }, variables: { type: "object" } }, required: ["query"] } },
      { name: "http_request", description: "Make an HTTP request to any external API (REST, webhooks, etc.)", parameters: { type: "object", properties: { url: { type: "string" }, method: { type: "string" }, body: { type: "object" }, bearer_token: { type: "string" }, headers: { type: "object" } }, required: ["url"] } },
    );
  }
  return [{ functionDeclarations: allDeclarations }];
}

async function consultAgent(targetId: string, question: string, githubToken: string, depth: number, groupChatId?: string, topicMap?: Record<string, number>): Promise<string> {
  if (depth >= 2) return "[максимальная глубина цепочки достигнута]";
  const target = AGENTS.find(a => a.id === targetId);
  if (!target) return `[агент не найден: ${targetId}. Доступные id: ${AGENTS.map(a=>a.id).join(", ")}]`;
  try {
    const baseUrl = process.env.APP_URL || "https://prox-three-taupe.vercel.app";
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 28_000);
    const targetThreadId = topicMap?.[targetId];
    const res = await fetch(`${baseUrl}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: question,
        agentId: targetId,
        history: [],
        githubToken,
        _depth: depth + 1,
        ...(groupChatId && targetThreadId ? { _groupChatId: groupChatId, _threadId: targetThreadId } : {}),
      }),
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
    geminiConfigured: !!process.env.GEMINI_API_KEY,
  });
}

export async function POST(req: NextRequest) {
  try {
    const { message, agentId, history, githubToken: clientToken, _depth = 0, _groupChatId, _threadId, _workerDispatch } = await req.json();
    if (!message || !agentId) return NextResponse.json({ error: "message and agentId required" }, { status: 400 });
    const agent = AGENTS.find((a) => a.id === agentId);
    if (!agent) return NextResponse.json({ error: "Unknown agent" }, { status: 400 });

    const githubToken = clientToken?.trim() || process.env.GITHUB_TOKEN || "";
    const hasGithub = !!githubToken;

    const agentList = AGENTS.map(a => `${a.id} — ${a.name} (${a.role})`).join("\n");
    const currentProjectRepo = await loadProjectRepo();
    const [repoOwner, repoName] = currentProjectRepo ? currentProjectRepo.split("/") : ["", ""];
    const githubInstruction = hasGithub
      ? (currentProjectRepo
        ? `\n\n🗂 ТЕКУЩИЙ ПРОЕКТ — РЕПОЗИТОРИЙ: ${currentProjectRepo}\n` +
          `ПРАВИЛА (СТРОГО):\n` +
          `1. Работай ТОЛЬКО в репо ${currentProjectRepo}. owner="${repoOwner}", repo="${repoName}".\n` +
          `2. НИКОГДА не создавай новые репозитории — ты не Лена.\n` +
          `3. Сразу вызывай github_create_or_update_file для каждого файла.\n` +
          `4. Пиши ТОЛЬКО реальный рабочий код. README не нужен.`
        : agentId === "pm"
          ? `\n\nGITHUB — ПРАВИЛА ДЛЯ ЛЕНЫ:\n` +
            `1. Когда пользователь даёт новый проект — сначала создай репо через github_create_repo (выбери имя сама).\n` +
            `2. После создания репо — сообщи команде имя репо в задачах [TASK:agentId:задание в репо owner/repo].\n` +
            `3. Сама также работай в этом репо через github_create_or_update_file.`
          : `\n\nGITHUB — ПРАВИЛА:\n1. Репо указано в задаче. Работай только в нём. НИКОГДА не создавай новые репозитории.\n2. Сразу вызывай github_create_or_update_file для каждого файла.`)
      : "";
    const selfDelegateWarning = agentId === "pm"
      ? "\n\n🔴 ДЕЛЕГИРОВАНИЕ — ТЕХНИЧЕСКИЙ МЕХАНИЗМ (ОБЯЗАТЕЛЬНО ПОНЯТЬ):\n" +
        "Задача ФИЗИЧЕСКИ доходит до агента ТОЛЬКО через маркер [TASK:agentId:текст задачи].\n" +
        "Если ты написала 'задачи поставлены' без маркера — агент НИЧЕГО не получил, это пустые слова.\n" +
        "ФОРМАТ: [TASK:frontend:сделай X] [TASK:backend:сделай Y] — прямо в тексте ответа.\n" +
        "НИКОГДА не пиши 'я поставила задачи' без этих маркеров — это ложь.\n\n" +
        "🔴 ЗАПРЕЩЕНО:\n" +
        "- [TASK:pm:...] — нельзя ставить задачи себе\n" +
        "- Писать 'Задачи поставлены: Lena' или 'делегировала' без маркеров\n\n" +
        "✅ АЛГОРИТМ РАБОТЫ ЛЕНЫ:\n" +
        "1. Пользователь говорит задачу → ты сразу анализируешь ЧТО нужно и КТО это делает\n" +
        "2. Ставишь задачи через [TASK:agentId:конкретное задание] — прямо в ответе\n" +
        "3. Когда агент отвечает 'Готово: ...' — ты СРАЗУ вызываешь github_list_files чтобы проверить\n" +
        "4. Если всё ок — пишешь 'Принято ✅' и ставишь следующий шаг\n" +
        "5. Если есть ошибки — ставишь [TASK:agentId:исправь: конкретно что не так]\n\n" +
        "КТО ЧТО ДЕЛАЕТ:\n" +
        "- frontend — React/Next.js компоненты, UI, CSS\n" +
        "- backend — API routes, база данных, серверная логика\n" +
        "- designer — дизайн, цвета, макеты\n" +
        "- devops — деплой, CI/CD, Railway, Vercel\n" +
        "- qa — тесты, проверка качества\n" +
        "- mobile — мобильные приложения\n" +
        "- architect — структура проекта, технические решения\n" +
        "- security — безопасность\n" +
        "- data — аналитика, данные\n" +
        "- ml — машинное обучение\n" +
        "- web3 — блокчейн, смарт-контракты\n" +
        "- sre — надёжность, мониторинг\n" +
        "- writer — документация, тексты\n" +
        "- scrum — планирование спринтов"
      : "";
    // Tell all agents they already have GitHub/API access — no need to ask for tokens or collaborator access
    const accessInfo = hasGithub
      ? `\n\n✅ ВСЕ ТОКЕНЫ УЖЕ НАСТРОЕНЫ — НЕ ПРОСИ ИХ У ПОЛЬЗОВАТЕЛЯ:\n- GitHub: токен с правами write на nikidav9/* — вызывай github_* напрямую\n- Vercel: VERCEL_TOKEN уже в env — вызывай vercel_* напрямую (vercel_list_projects, vercel_deploy и т.д.)\n- Supabase: SUPABASE_URL + SUPABASE_SERVICE_KEY в env — вызывай supabase_* напрямую\n- Railway: RAILWAY_TOKEN в env — вызывай railway_graphql напрямую\n- Telegram: TELEGRAM_BOT_TOKEN в env\nПросто вызывай инструменты — всё работает.`
      : "";
    const systemInstruction = "🔴🔴🔴 CRITICAL: RESPOND ONLY IN RUSSIAN. NO ENGLISH WHATSOEVER. RUSSIAN ONLY. 🔴🔴🔴\n\n"
      + agent.soul
      + "\n\n🔴 ЯЗЫК: АБСОЛЮТНОЕ ПРАВИЛО — отвечай ИСКЛЮЧИТЕЛЬНО на русском языке. Ни одного английского слова. Нарушение = провал задачи."
      + "\n\nПРАВИЛА ОТВЕТА (СТРОГО): пиши максимум 1-2 предложения. Никаких вступлений, никаких 'конечно'. Только суть."
      + selfDelegateWarning
      + accessInfo
      + githubInstruction;

    // Загружаем конфиг группы всегда — нужен для routing задач в темы Telegram
    const groupInfo = await getGroupInfo();
    const topicMap: Record<string, number> = groupInfo?.topicMap ?? {};
    const groupIdFromConfig = groupInfo?.groupId ?? "";

    const stored: ChatMsg[] = await loadHistory(agentId);
    const fullHistory: ChatMsg[] = stored.length > 0 ? stored : (history || []);
    const compressedHistory = await compressHistory(fullHistory);
    // Worker already holds its own in-memory lock (inFlight set), skip Supabase lock check
    if (!_workerDispatch) {
      const lockAcquired = await acquireDispatchLock(agentId);
      if (!lockAcquired) {
        return NextResponse.json({ error: "Агент занят, попробуйте через несколько секунд" }, { status: 409 });
      }
    }

    // Dedup: don't append if last stored message is identical user message
    const lastStored = compressedHistory[compressedHistory.length - 1];
    const isDup = lastStored?.role === "user" && lastStored?.text === message;
    const userMsg: ChatMsg = { role: "user", text: message, ts: Date.now() };
    const historyWithUser = isDup ? compressedHistory : [...compressedHistory, userMsg];
    await saveHistory(agentId, historyWithUser);

    // Resolve group chat context: из запроса → из истории → из конфига группы
    const tgGroupChatId = _groupChatId
      || historyWithUser.filter(m => m.role === "user").at(-1)?._groupChatId
      || groupIdFromConfig;
    const tgThreadId = _threadId
      || historyWithUser.filter(m => m.role === "user").at(-1)?._threadId
      || topicMap[agentId];

    // Append Russian language reminder to every user message sent to the model
    const messageForModel = message + "\n\n[ВАЖНО: отвечай ТОЛЬКО на русском языке]";

    const trimmedHistory = compressedHistory.filter(m => m.role === "user" || m.role === "model");

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

    await ensureCooldownsLoaded();
    const orderedPool = availableModels();
    for (const entry of orderedPool) {
      const modelTimeout = 25_000;
      try {
        if (entry.provider === "gemini") {
          const gModel = genAI.getGenerativeModel({
            model: entry.model, systemInstruction,
            tools: buildGeminiTools(hasGithub, agentId === "pm"),
          });
          const chat = gModel.startChat({
            history: trimmedHistory.map(msg => ({ role: msg.role, parts: [{ text: msg.text }] })),
          });
          let result = await withTimeout(
            chat.sendMessage(messageForModel, { generationConfig: { maxOutputTokens: 800 } } as never),
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
                const reply = await consultAgent(String(args.agentId), String(args.question), githubToken, _depth, tgGroupChatId ? String(tgGroupChatId) : undefined, topicMap);
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
          text = stripThinking(result.response.text());
          if (isEnglishResponse(text)) console.log(`[lang] ${entry.id} responded in English`);
          usedProvider = entry.id;
          break;
        }
      } catch (err) {
        const errMsg = String(err);
        lastError = errMsg;
        await markCooled(entry.id, errMsg);
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
      // Never self-delegate
      if (aid === agentId) return;
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
    // Collect self-delegations separately so we can forward them to Telegram as user questions
    const selfDelegations: string[] = [];
    const taskMarkerRe = /\[TASK:([\w-]+):([^\]]+)\]/g;
    let tm: RegExpExecArray | null;
    while ((tm = taskMarkerRe.exec(text)) !== null) {
      if (tm[1] === agentId) selfDelegations.push(tm[2].trim());
      else addCall(tm[1], tm[2].trim());
    }

    // Safeguard: если Лена написала «задачи поставлены X, Y» но без маркеров — парсим упомянутых агентов
    // и создаём задачи программно из последнего сообщения пользователя
    if (agentId === "pm" && inlineCalls.length === 0) {
      const mentionRe = new RegExp(`\\b(${AGENTS.filter(a => a.id !== "pm").map(a => a.id).join("|")})\\b`, "gi");
      const delegationHint = /поставил|делегировал|задач|отправил|написал|Alex|Sam|Max|Mia|Dan|Nina|Kai|Rio|Leo|Zoe|Rex|Eva|Noa|Vik/i;
      if (delegationHint.test(text)) {
        let mm: RegExpExecArray | null;
        while ((mm = mentionRe.exec(text)) !== null) {
          addCall(mm[1].toLowerCase(), message);
        }
      }
    }

    if (inlineCalls.length > 0) {
      await Promise.all(inlineCalls.map(async ({ agentId: tId, question }) => {
        // Add "report back to pm when done" instruction for non-pm agents
        const taskWithCallback = agentId !== "pm" && tId !== "pm"
          ? question
          : question;
        // Если есть активное репо — явно указываем его агенту
        const repoNote = currentProjectRepo
          ? `\n\n🗂 Работай в репо: ${currentProjectRepo} (owner="${repoOwner}", repo="${repoName}")`
          : "";
        // Если pm даёт задачу — просим агента сообщить о завершении
        const finalTask = agentId === "pm"
          ? `${question}${repoNote}\n\nКогда выполнишь — добавь [TASK:pm:Готово: краткий итог что сделал]`
          : question + repoNote;
        const existing = await loadHistory(tId);
        const targetThread = tgGroupChatId ? topicMap[tId] : undefined;
        const taskMsg: ChatMsg = {
          role: "user",
          text: finalTask,
          ts: Date.now(),
          ...(tgGroupChatId && targetThread ? { _groupChatId: String(tgGroupChatId), _threadId: targetThread } : {}),
        };
        await saveHistory(tId, [...existing, taskMsg]);
        githubActions.push(`👥 ${tId}: ${taskWithCallback.slice(0, 100)}`);
      }));
      text = text
        .replace(/\[TASK:[\w-]+:[^\]]+\]\s*/g, "")
        .replace(/consult_agent\s*\([^)]*\)\s*/g, "")
        .replace(/(?:function=consult_agent|<function=consult_agent)[^\n]*(?:\n|$)/g, "")
        .replace(/<\/function>\s*/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      // If text became empty after stripping markers, generate a confirmation
      if (!text && inlineCalls.length > 0) {
        const names = inlineCalls.map(c => {
          const a = AGENTS.find(x => x.id === c.agentId);
          return a ? a.name : c.agentId;
        });
        text = `Задачи поставлены: ${names.join(", ")}. Жду результатов.`;
      }
    }

    // Always strip any leftover [TASK:] markers from saved text
    text = text.replace(/\[TASK:[\w-]+:[^\]]+\]\s*/g, "").trim();
    // Strip self-delegation artifacts the model writes as literal text
    text = text.replace(/Задачи поставлены:\s*(?:Lena|pm)[^.]*\.\s*Жду результатов\.?/gi, "").trim();
    text = text.replace(/Поставила задачи:\s*(?:Lena|pm)[^.]*\.?/gi, "").trim();
    // If text is empty but Lena self-delegated questions — use those questions as the message
    if (!text && selfDelegations.length > 0) {
      text = selfDelegations.join("\n");
    }
    if (!text) text = "Готово.";

    const botMsg: ChatMsg = { role: "model", text, ts: Date.now(), ...(githubActions.length ? { githubActions } : {}) };
    await saveHistory(agentId, [...historyWithUser, botMsg]);
    await releaseDispatchLock(agentId);

    // Case 1: message came from a group topic → reply in same topic
    if (tgGroupChatId && tgThreadId) {
      if (text && text !== "Готово.") {
        await sendTelegram(String(tgGroupChatId), text, Number(tgThreadId));
      }
    } else if (!_workerDispatch) {
      // Case 2: web UI request → mirror to Telegram group topic for this agent
      const groupInfo = await getGroupInfo();
      if (groupInfo) {
        const webThreadId = groupInfo.topicMap[agentId];
        if (webThreadId) {
          // Зеркалируем сообщение пользователя
          if (!isDup) {
            await sendTelegram(groupInfo.groupId, `👤 Создатель: ${message}`, webThreadId);
          }
          // Зеркалируем ответ агента
          if (text && text !== "Готово.") {
            await sendTelegram(groupInfo.groupId, `🤖 ${agent.name}: ${text}`, webThreadId);
          }
          // Если Лена раздала задачи — показываем это тоже
          const delegations = githubActions.filter(a => a.startsWith("👥"));
          if (delegations.length > 0) {
            const summary = delegations.map(d => {
              const [id, task] = d.replace("👥 ", "").split(": ");
              const agentObj = AGENTS.find(a => a.id === id);
              return `  • ${agentObj?.name ?? id}: ${task?.slice(0, 80) ?? "задача"}`;
            }).join("\n");
            await sendTelegram(groupInfo.groupId, `📋 Задачи поставлены:\n${summary}`, webThreadId);
          }
        }
      }
    }

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
