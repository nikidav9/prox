const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const AGENT_URL = process.env.AGENT_URL || "https://prox-two-zeta.vercel.app";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const INTERVAL_MS = 10_000;
const LOCK_TTL = 90_000; // 90s — agent API max timeout is 60s

// In-memory set for this worker instance
const inFlight = new Set();

async function loadAllHistories() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/chat_histories?select=agent_id,messages`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  return res.ok ? res.json() : [];
}

// Distributed lock via Supabase — prevents browser + Railway + cron from double-dispatching
async function tryLock(agentId) {
  const lockId = `_lock_${agentId}`;
  const until = Date.now() + LOCK_TTL;
  // Upsert lock record — only if no existing unexpired lock
  const existing = await fetch(`${SUPABASE_URL}/rest/v1/chat_histories?agent_id=eq.${lockId}&select=messages`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  }).then(r => r.json()).catch(() => []);

  const existingLock = existing?.[0]?.messages?.[0];
  if (existingLock && existingLock.ts > Date.now()) return false; // locked by someone else

  await fetch(`${SUPABASE_URL}/rest/v1/chat_histories`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ agent_id: lockId, messages: [{ role: "system", text: "lock", ts: until }], updated_at: new Date().toISOString() }),
  }).catch(() => {});
  return true;
}

async function releaseLock(agentId) {
  const lockId = `_lock_${agentId}`;
  await fetch(`${SUPABASE_URL}/rest/v1/chat_histories`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ agent_id: lockId, messages: [{ role: "system", text: "lock", ts: 0 }], updated_at: new Date().toISOString() }),
  }).catch(() => {});
}

async function tick() {
  try {
    const rows = await loadAllHistories();
    for (const row of rows) {
      const { agent_id, messages } = row;
      if (!agent_id || agent_id.startsWith("_")) continue;
      if (!messages?.length) continue;
      const last = messages[messages.length - 1];
      if (last?.role !== "user") continue;
      if (inFlight.has(agent_id)) continue;

      const locked = await tryLock(agent_id);
      if (!locked) { console.log(`[worker] ${agent_id} locked, skipping`); continue; }

      inFlight.add(agent_id);
      console.log(`[worker] dispatching ${agent_id}: ${last.text?.slice(0, 60)}`);
      fetch(`${AGENT_URL}/api/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: last.text, agentId: agent_id, history: [] }),
      })
        .then(r => r.json())
        .then(d => console.log(`[worker] ${agent_id} done: ${(d.text||'').slice(0, 60)}`))
        .catch(e => console.error(`[worker] ${agent_id} error:`, e.message))
        .finally(() => { inFlight.delete(agent_id); releaseLock(agent_id); });
    }
  } catch (e) {
    console.error("[worker] tick error:", e.message);
  }
}

console.log("[worker] started, interval:", INTERVAL_MS / 1000, "s");
tick();
setInterval(tick, INTERVAL_MS);
