import { GoogleGenerativeAI, Tool, SchemaType } from "@google/generative-ai";
import Groq from "groq-sdk";
import { NextRequest, NextResponse } from "next/server";
import { AGENTS } from "@/lib/agents";
import { loadHistory, saveHistory, acquireDispatchLock, releaseDispatchLock, ChatMsg } from "@/lib/supabase";
import { sendTelegram, getTelegramChatId } from "@/app/api/telegram/route";

export const maxDuration = 60;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;
const cerebrasKey = process.env.CEREBRAS_API_KEY || "";

type Provider = "gemini" | "groq" | "openrouter" | "cerebras";
interface ModelEntry { id: string; provider: Provider; model: string }

const MODEL_POOL: ModelEntry[] = [
  // ── OpenRouter (verified live 2026-06-03) ───────────────────────────
  { id: "or-qwen3-coder",          provider: "openrouter", model: "qwen/qwen3-coder:free" },
  { id: "or-kimi-k2-6",            provider: "openrouter", model: "moonshotai/kimi-k2.6:free" },
  { id: "or-qwen3-next-80b",       provider: "openrouter", model: "qwen/qwen3-next-80b-a3b-instruct:free" },
  { id: "or-nemotron-super-120b",  provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free" },
  { id: "or-gemma4-31b",           provider: "openrouter", model: "google/gemma-4-31b-it:free" },
  { id: "or-gemma4-26b",           provider: "openrouter", model: "google/gemma-4-26b-a4b-it:free" },
  { id: "or-gpt-oss-120b",         provider: "openrouter", model: "openai/gpt-oss-120b:free" },
  { id: "or-gpt-oss-20b",          provider: "openrouter", model: "openai/gpt-oss-20b:free" },
  { id: "or-llama33-70b",          provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free" },
  { id: "or-hermes-405b",          provider: "openrouter", model: "nousresearch/hermes-3-llama-3.1-405b:free" },
  { id: "or-glm45-air",            provider: "openrouter", model: "z-ai/glm-4.5-air:free" },
  { id: "or-nemotron-nano-30b",    provider: "openrouter", model: "nvidia/nemotron-3-nano-30b-a3b:free" },
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
  // Model removed/decommissioned — skip for 24h
  const isDeadModel = msg.toLowerCase().includes("no endpoints found")
    || msg.toLowerCase().includes("decommissioned")
    || msg.toLowerCase().includes("no longer supported")
    || msg.toLowerCase().includes("model not found");
  const waitMs = isDeadModel ? 24 * 3600_000
    : secMatch ? Math.ceil(parseFloat(secMatch[1]) * 1000)
    : minMatch ? parseInt(minMatch[1]) * 60_000
    : isQuota ? 60_000 : 15_000;
  if (isDeadModel) console.warn(`[agent] dead model skipped for 24h: ${id} — ${msg}`);
  const until = Date.now() + Math.min(waitMs + 5000, 24 * 3600_000);
  cooldowns.set(id, until);
  // Cool all Groq models on quota (they share one API key quota)
  const entry = MODEL_POOL.find(m => m.id === id);
  if (entry && isQuota && entry.provider === "groq") {
    MODEL_POOL.filter(m => m.provider === "groq").forEach(m => cooldowns.set(m.id, until));
  }
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
      { type: "function" as const, function: { name: "github_get_file", description: "Read file content", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" } }, required: ["owner", "repo", "path"] } } },
      { type: "function" as const, function: { name: "github_delete_file", description: "Delete a file", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" }, message: { type: "string" } }, required: ["owner", "repo", "path"] } } },
      { type: "function" as const, function: { name: "github_create_pull_request", description: "Create a pull request", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" }, head: { type: "string" }, base: { type: "string" } }, required: ["owner", "repo", "title", "head"] } } },
      { type: "function" as const, function: { name: "github_list_pull_requests", description: "List pull requests", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" } }, required: ["owner", "repo"] } } },
      { type: "function" as const, function: { name: "github_merge_pull_request", description: "Merge a pull request", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, pull_number: { type: "number" }, commit_title: { type: "string" }, merge_method: { type: "string" } }, required: ["owner", "repo", "pull_number"] } } },
      { type: "function" as const, function: { name: "github_close_issue", description: "Close an issue", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "number" } }, required: ["owner", "repo", "issue_number"] } } },
      { type: "function" as const, function: { name: "github_add_comment", description: "Add comment to issue/PR", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "number" }, body: { type: "string" } }, required: ["owner", "repo", "issue_number", "body"] } } },
      { type: "function" as const, function: { name: "github_list_actions_runs", description: "List recent Actions runs", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } } },
      { type: "function" as const, function: { name: "github_get_actions_run", description: "Get a specific Actions run", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, run_id: { type: "number" } }, required: ["owner", "repo", "run_id"] } } },
      { type: "function" as const, function: { name: "github_list_actions_jobs", description: "List jobs/steps of an Actions run", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, run_id: { type: "number" } }, required: ["owner", "repo", "run_id"] } } },
      { type: "function" as const, function: { name: "github_rerun_actions", description: "Re-run a failed Actions workflow", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, run_id: { type: "number" } }, required: ["owner", "repo", "run_id"] } } },
      { type: "function" as const, function: { name: "github_list_secrets", description: "List Actions secrets names", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } } },
      { type: "function" as const, function: { name: "github_repo_settings", description: "Get repo settings", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } } },
      { type: "function" as const, function: { name: "vercel_deploy", description: "Trigger Vercel production deployment", parameters: { type: "object", properties: { project_name: { type: "string" }, branch: { type: "string" } } } } },
      { type: "function" as const, function: { name: "vercel_list_deployments", description: "List recent Vercel deployments", parameters: { type: "object", properties: { project_id: { type: "string" } } } } },
      { type: "function" as const, function: { name: "vercel_get_deployment", description: "Get Vercel deployment status", parameters: { type: "object", properties: { deployment_id: { type: "string" } }, required: ["deployment_id"] } } },
      { type: "function" as const, function: { name: "vercel_list_projects", description: "List all Vercel projects", parameters: { type: "object", properties: {} } } },
      { type: "function" as const, function: { name: "vercel_set_env", description: "Set env var on Vercel project", parameters: { type: "object", properties: { project_id: { type: "string" }, key: { type: "string" }, value: { type: "string" } }, required: ["project_id", "key", "value"] } } },
      { type: "function" as const, function: { name: "supabase_query", description: "Query a Supabase table", parameters: { type: "object", properties: { table: { type: "string" }, select: { type: "string" }, filter_col: { type: "string" }, filter: { type: "string" }, limit: { type: "number" } }, required: ["table"] } } },
      { type: "function" as const, function: { name: "supabase_insert", description: "Insert a row into Supabase", parameters: { type: "object", properties: { table: { type: "string" }, data: { type: "object" } }, required: ["table", "data"] } } },
      { type: "function" as const, function: { name: "supabase_update", description: "Update rows in Supabase", parameters: { type: "object", properties: { table: { type: "string" }, filter_col: { type: "string" }, filter_val: { type: "string" }, data: { type: "object" } }, required: ["table", "filter_val", "data"] } } },
      { type: "function" as const, function: { name: "railway_deploy", description: "Trigger Railway deployment", parameters: { type: "object", properties: { service_id: { type: "string" }, environment_id: { type: "string" } }, required: ["service_id", "environment_id"] } } },
      { type: "function" as const, function: { name: "railway_graphql", description: "Run any Railway GraphQL query/mutation", parameters: { type: "object", properties: { query: { type: "string" }, variables: { type: "object" } }, required: ["query"] } } },
      { type: "function" as const, function: { name: "http_request", description: "Make HTTP request to any external API", parameters: { type: "object", properties: { url: { type: "string" }, method: { type: "string" }, body: { type: "object" }, bearer_token: { type: "string" }, headers: { type: "object" } }, required: ["url"] } } },
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
        ? `\n\nGITHUB — ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:\n1. Репозиторий: ${sharedRepo}. Никогда не создавай новые репо.\n2. Сразу вызывай github_create_or_update_file для КАЖДОГО файла.\n3. Пиши ТОЛЬКО реальный код (.ts/.tsx/.py/.css/конфиги). README не нужен.\n4. Минимум 2 файла с полным рабочим кодом, не заглушками.\n5. owner="${sharedRepo.split("/")[0]}", repo="${sharedRepo.split("/")[1]}"`
        : "\n\nGITHUB — ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:\n1. Репо указано в задаче (формат nikidav9/repo). Никогда не создавай новые репо.\n2. Сразу вызывай github_create_or_update_file для КАЖДОГО файла.\n3. Пиши ТОЛЬКО реальный код (.ts/.tsx/.py/.css/конфиги). README не нужен.\n4. Минимум 2 файла с полным рабочим кодом, не заглушками.")
      : "";
    const selfDelegateWarning = agentId === "pm"
      ? "\n\n⚠️ ЗАПРЕЩЕНО (АБСОЛЮТНО):\n- Никогда [TASK:pm:...] — ты не можешь ставить задачи самой себе\n- Никогда не пиши фразу 'Задачи поставлены: Lena'\n- Если нужна инфа — спроси пользователя напрямую: «Создатель, [вопрос]?»\n- Если знаешь что делать — делай сразу через инструменты (github_*, vercel_*, http_request)"
      : "";
    // Tell all agents they already have GitHub/API access — no need to ask for tokens or collaborator access
    const accessInfo = hasGithub
      ? `\n\n✅ ВСЕ ТОКЕНЫ УЖЕ НАСТРОЕНЫ — НЕ ПРОСИ ИХ У ПОЛЬЗОВАТЕЛЯ:\n- GitHub: токен с правами write на nikidav9/* — вызывай github_* напрямую\n- Vercel: VERCEL_TOKEN уже в env — вызывай vercel_* напрямую (vercel_list_projects, vercel_deploy и т.д.)\n- Supabase: SUPABASE_URL + SUPABASE_SERVICE_KEY в env — вызывай supabase_* напрямую\n- Railway: RAILWAY_TOKEN в env — вызывай railway_graphql напрямую\n- Telegram: TELEGRAM_BOT_TOKEN в env\nПросто вызывай инструменты — всё работает.`
      : "";
    const systemInstruction = "🔴🔴🔴 CRITICAL: RESPOND ONLY IN RUSSIAN. NO ENGLISH WHATSOEVER. RUSSIAN ONLY. 🔴🔴🔴\n\n"
      + agent.soul
      + "\n\n🔴 ЯЗЫК: АБСОЛЮТНОЕ ПРАВИЛО — отвечай ИСКЛЮЧИТЕЛЬНО на русском языке. Ни одного английского слова. Даже технические термины — по-русски или транслитом. Нарушение = провал задачи."
      + "\n\nПРАВИЛА ОТВЕТА (СТРОГО): пиши максимум 1-2 предложения. Никаких вступлений, никаких 'конечно', никаких списков. Только суть."
      + `\n\nДЕЛЕГИРОВАНИЕ ЗАДАЧ: если пользователь говорит 'дай ребятам', 'пусть команда сделает', 'поставь задачу' — сразу ставь задачи через [TASK:agentId:задание]. НЕ создавай GitHub issues вместо делегирования. Список агентов:\n${agentList}`
      + selfDelegateWarning
      + accessInfo
      + githubInstruction;

    const stored: ChatMsg[] = await loadHistory(agentId);
    const fullHistory: ChatMsg[] = stored.length > 0 ? stored : (history || []);
    const compressedHistory = await compressHistory(fullHistory);
    const userMsg: ChatMsg = { role: "user", text: message, ts: Date.now() };
    await saveHistory(agentId, [...compressedHistory, userMsg]);
    // Hold distributed lock so Railway worker doesn't double-dispatch this agent
    await acquireDispatchLock(agentId);

    // Append Russian language reminder to every user message sent to the model
    const messageForModel = message + "\n\n[ВАЖНО: отвечай ТОЛЬКО на русском языке]";

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
      { role: "user", content: messageForModel },
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

    // Single ordered pool: Gemini → Groq → Cerebras → OpenRouter
    // Gemini + Groq first: best Russian language compliance
    // Cerebras + OpenRouter: fast fallback with 20+ models
    const PROVIDER_ORDER = ["gemini", "groq", "cerebras", "openrouter"];
    const orderedPool = PROVIDER_ORDER.flatMap(p => availableModels().filter(e => e.provider === p));
    for (const entry of orderedPool) {
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
          text = stripThinking(result.response.text());
          if (isEnglishResponse(text)) console.log(`[lang] ${entry.id} responded in English`);
          usedProvider = entry.id;
          break;

        } else if (entry.provider === "groq" && groq) {
          const groqMessages: Groq.Chat.ChatCompletionMessageParam[] = [
            { role: "system", content: systemInstruction },
            ...groqHistory,
            { role: "user", content: messageForModel },
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
              text = stripThinking(msg.content || "Нет ответа");
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
          if (isEnglishResponse(text)) console.log(`[lang] ${entry.id} responded in English`);
          usedProvider = entry.id;
          break;
        } else if (entry.provider === "cerebras" || entry.provider === "openrouter") {
          const url = entry.provider === "cerebras"
            ? "https://api.cerebras.ai/v1/chat/completions"
            : "https://openrouter.ai/api/v1/chat/completions";
          const auth = entry.provider === "cerebras"
            ? `Bearer ${cerebrasKey}`
            : `Bearer ${process.env.OPENROUTER_API_KEY}`;
          const extra: Record<string,string> = entry.provider === "openrouter"
            ? { "HTTP-Referer": "https://prox-two-zeta.vercel.app", "X-Title": "Dev Office" } : {};
          if (!auth || auth === "Bearer ") continue;
          const r = await callOpenAICompat(url, auth, entry, chatMessages, chatTools, 15_000, extra);
          let curMessages = [...chatMessages];
          let curMsg = r.msg;
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
              const r2 = await callOpenAICompat(url, auth, entry, curMessages, chatTools, 15_000, extra);
              curMsg = r2.msg;
            } catch { break; }
          }
          text = stripThinking(curMsg.content || "");
          if (isEnglishResponse(text)) console.log(`[lang] ${entry.id} responded in English`);
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

    if (inlineCalls.length > 0) {
      await Promise.all(inlineCalls.map(async ({ agentId: tId, question }) => {
        // Add "report back to pm when done" instruction for non-pm agents
        const taskWithCallback = agentId !== "pm" && tId !== "pm"
          ? question
          : question;
        // If PM assigned this task, tell the target agent to report back
        const finalTask = agentId === "pm"
          ? `${question}\n\nКогда выполнишь — добавь [TASK:pm:Готово: краткий итог что сделал]`
          : question;
        const existing = await loadHistory(tId);
        await saveHistory(tId, [...existing, { role: "user", text: finalTask }]);
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
    await saveHistory(agentId, [...compressedHistory, userMsg, botMsg]);
    await releaseDispatchLock(agentId);

    // Send Lena's responses to Telegram
    if (agentId === "pm") {
      const chatId = await getTelegramChatId();
      if (chatId) {
        const delegations = githubActions.filter(a => a.startsWith("👥"));
        if (text && text !== "Готово.") {
          await sendTelegram(chatId, `💬 Лена:\n${text}`);
        } else if (delegations.length > 0) {
          // She delegated but wrote no text — summarize who got tasks
          const summary = delegations.map(d => d.replace("👥 ", "")).map(d => {
            const [id, task] = d.split(": ");
            const agent = AGENTS.find(a => a.id === id);
            return `• ${agent?.name ?? id}: ${task?.slice(0, 60) ?? "задача"}`;
          }).join("\n");
          await sendTelegram(chatId, `✅ Лена раздала задачи:\n${summary}`);
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
