const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const AGENT_URL = process.env.AGENT_URL || "https://prox-two-zeta.vercel.app";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const INTERVAL_MS = 30_000; // every 30 seconds

async function loadAllHistories() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/chat_histories?select=agent_id,messages`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  return res.ok ? res.json() : [];
}

const inFlight = new Set();

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

      inFlight.add(agent_id);
      console.log(`[worker] dispatching ${agent_id}: ${last.text?.slice(0, 60)}`);
      fetch(`${AGENT_URL}/api/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: last.text,
          agentId: agent_id,
          history: [],
          githubToken: GITHUB_TOKEN,
        }),
      })
        .then(r => r.json())
        .then(d => console.log(`[worker] ${agent_id} done: ${d.text?.slice(0, 60)}`))
        .catch(e => console.error(`[worker] ${agent_id} error:`, e.message))
        .finally(() => inFlight.delete(agent_id));
    }
  } catch (e) {
    console.error("[worker] tick error:", e.message);
  }
}

console.log("[worker] started, interval:", INTERVAL_MS / 1000, "s");
tick();
setInterval(tick, INTERVAL_MS);
