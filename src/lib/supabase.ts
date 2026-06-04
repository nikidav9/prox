import { createClient } from "@supabase/supabase-js";

export type ChatMsg = { role: "user" | "model" | "system"; text: string; githubActions?: string[]; ts?: number; _groupChatId?: string; _threadId?: number };

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_KEY!;

function getClient() {
  if (!url || !key) return null;
  return createClient(url, key);
}

export async function loadHistory(agentId: string): Promise<ChatMsg[]> {
  const sb = getClient();
  if (!sb) return [];
  try {
    const { data } = await sb
      .from("chat_histories")
      .select("messages")
      .eq("agent_id", agentId)
      .single();
    return (data?.messages as ChatMsg[]) || [];
  } catch { return []; }
}

export async function saveHistory(agentId: string, messages: ChatMsg[]): Promise<void> {
  const sb = getClient();
  if (!sb) return;
  try {
    await sb.from("chat_histories").upsert(
      { agent_id: agentId, messages, updated_at: new Date().toISOString() },
      { onConflict: "agent_id" }
    );
  } catch {}
}

export async function loadAllHistories(): Promise<Record<string, ChatMsg[]>> {
  const sb = getClient();
  if (!sb) return {};
  try {
    const { data } = await sb.from("chat_histories").select("agent_id, messages");
    if (!data) return {};
    const result: Record<string, ChatMsg[]> = {};
    for (const row of data) result[row.agent_id] = row.messages || [];
    return result;
  } catch { return {}; }
}

const LOCK_TTL = 90_000;

export async function acquireDispatchLock(agentId: string): Promise<boolean> {
  const sb = getClient();
  if (!sb) return true; // no supabase = allow (dev mode)
  const lockId = `_lock_${agentId}`;
  try {
    await sb.from("chat_histories").upsert(
      { agent_id: lockId, messages: [{ role: "system", text: "lock", ts: Date.now() + LOCK_TTL }], updated_at: new Date().toISOString() },
      { onConflict: "agent_id" }
    );
    return true;
  } catch { return true; }
}

export async function releaseDispatchLock(agentId: string): Promise<void> {
  const sb = getClient();
  if (!sb) return;
  const lockId = `_lock_${agentId}`;
  try {
    await sb.from("chat_histories").upsert(
      { agent_id: lockId, messages: [{ role: "system", text: "lock", ts: 0 }], updated_at: new Date().toISOString() },
      { onConflict: "agent_id" }
    );
  } catch {}
}

export async function loadCooldowns(): Promise<Record<string, number>> {
  const sb = getClient();
  if (!sb) return {};
  try {
    const { data } = await sb.from("chat_histories").select("messages").eq("agent_id", "_cooldowns").single();
    return (data?.messages as unknown as Record<string, number>) || {};
  } catch { return {}; }
}

export async function saveCooldowns(data: Record<string, number>): Promise<void> {
  const sb = getClient();
  if (!sb) return;
  try {
    await sb.from("chat_histories").upsert(
      { agent_id: "_cooldowns", messages: data as unknown as ChatMsg[], updated_at: new Date().toISOString() },
      { onConflict: "agent_id" }
    );
  } catch {}
}

export async function loadProjectRepo(): Promise<string> {
  const sb = getClient();
  if (!sb) return process.env.SHARED_GITHUB_REPO || "";
  try {
    const { data } = await sb.from("chat_histories").select("messages").eq("agent_id", "_project_repo").single();
    return (data?.messages as unknown as { repo: string })?.repo || process.env.SHARED_GITHUB_REPO || "";
  } catch { return process.env.SHARED_GITHUB_REPO || ""; }
}

export async function saveProjectRepo(repo: string): Promise<void> {
  const sb = getClient();
  if (!sb) return;
  try {
    await sb.from("chat_histories").upsert(
      { agent_id: "_project_repo", messages: { repo } as unknown as ChatMsg[], updated_at: new Date().toISOString() },
      { onConflict: "agent_id" }
    );
  } catch {}
}

export async function clearHistory(agentId: string): Promise<void> {
  const sb = getClient();
  if (!sb) return;
  try {
    await sb.from("chat_histories").upsert(
      { agent_id: agentId, messages: [], updated_at: new Date().toISOString() },
      { onConflict: "agent_id" }
    );
  } catch {}
}
