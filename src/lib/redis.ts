import { Redis } from "@upstash/redis";

let redis: Redis | null = null;

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

export { redis };

export type ChatMsg = { role: "user" | "model" | "system"; text: string; githubActions?: string[] };

export async function loadHistory(agentId: string): Promise<ChatMsg[]> {
  if (!redis) return [];
  try {
    const data = await redis.get<ChatMsg[]>(`history:${agentId}`);
    return data || [];
  } catch { return []; }
}

export async function saveHistory(agentId: string, history: ChatMsg[]): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(`history:${agentId}`, history);
  } catch {}
}

export async function loadAllHistories(): Promise<Record<string, ChatMsg[]>> {
  if (!redis) return {};
  try {
    const keys = await redis.keys("history:*");
    if (!keys.length) return {};
    const values = await Promise.all(keys.map(k => redis!.get<ChatMsg[]>(k)));
    const result: Record<string, ChatMsg[]> = {};
    keys.forEach((k, i) => {
      const agentId = k.replace("history:", "");
      result[agentId] = values[i] || [];
    });
    return result;
  } catch { return {}; }
}
