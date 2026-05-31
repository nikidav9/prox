/**
 * Cloudflare Worker — VLESS relay
 * /vless → WebSocket relay to Railway VLESS backend (confirmed working)
 */

const RAILWAY_HOST = 'prox-production-e4e0.up.railway.app';
const RAILWAY_WS   = `wss://${RAILWAY_HOST}/vless`;

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (e) {
      return new Response('Worker error: ' + e.message, { status: 500 });
    }
  }
};

async function handleRequest(request, env) {
  const PROXY_USER = env.PROXY_USER || 'user';
  const PROXY_PASS = env.PROXY_PASS || 'changeme';
  const VLESS_UUID = env.VLESS_UUID || '';
  const url  = new URL(request.url);
  const host = request.headers.get('host') || url.host;

  // ── VLESS relay over WebSocket ────────────────────────────────────────────
  if (url.pathname === '/vless') {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket required', { status: 400 });
    }
    return handleVlessRelay(request);
  }

  // ── Upstream connectivity test ────────────────────────────────────────────
  if (url.pathname === '/cf-test') {
    try {
      const t0 = Date.now();
      const r = await fetch(`https://${RAILWAY_HOST}/`, { method: 'HEAD' });
      return new Response(
        `Railway reachable\nstatus: ${r.status}\nlatency: ${Date.now() - t0}ms`,
        { headers: { 'content-type': 'text/plain' } });
    } catch (e) {
      return new Response(`Railway unreachable\nerror: ${e.message}`,
        { status: 502, headers: { 'content-type': 'text/plain' } });
    }
  }

  // ── DNS-over-HTTPS ────────────────────────────────────────────────────────
  if (url.pathname === '/dns-query') {
    const target = new URL('https://dns.google/dns-query');
    url.searchParams.forEach((v, k) => target.searchParams.set(k, v));
    const up = await fetch(target.toString(), {
      method: request.method,
      headers: {
        'accept': request.headers.get('accept') || 'application/dns-message',
        ...(request.headers.get('content-type')
          ? { 'content-type': request.headers.get('content-type') } : {}),
      },
      body: request.body || undefined,
    });
    return new Response(up.body, {
      status: up.status,
      headers: {
        'content-type': up.headers.get('content-type') || 'application/dns-message',
        'cache-control': 'max-age=300',
        'access-control-allow-origin': '*',
      },
    });
  }

  // ── Management routes ─────────────────────────────────────────────────────
  if (request.method === 'GET' || request.method === 'HEAD') {
    if (url.pathname === '/pac') {
      return new Response(makePAC(host), {
        headers: { 'content-type': 'application/x-ns-proxy-autoconfig' },
      });
    }
    if (url.pathname === '/dns.mobileconfig') {
      return new Response(new TextEncoder().encode(makeDNSMobileconfig(host)).buffer, {
        headers: {
          'Content-Type': 'application/x-apple-aspen-config',
          'Content-Disposition': 'attachment; filename="dns-prox.mobileconfig"',
          'Cache-Control': 'no-store',
        },
      });
    }
    if (url.pathname === '/profile.mobileconfig') {
      return new Response(new TextEncoder().encode(makeMobileconfig(host, PROXY_USER, PROXY_PASS)).buffer, {
        headers: {
          'Content-Type': 'application/x-apple-aspen-config',
          'Content-Disposition': 'attachment; filename="prox.mobileconfig"',
          'Cache-Control': 'no-store',
        },
      });
    }
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(makeUI(host, PROXY_USER, PROXY_PASS, VLESS_UUID), {
        headers: { 'content-type': 'text/html;charset=utf-8' },
      });
    }
  }

  return new Response('Not Found', { status: 404 });
}

// ── VLESS WebSocket relay ─────────────────────────────────────────────────────
// Bridges client ↔ Railway VLESS backend via two WebSocket connections.
// Queues client messages until upstream opens to avoid drops.

async function handleVlessRelay(request) {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();

  let upstream;
  try {
    upstream = new WebSocket(RAILWAY_WS);
  } catch (e) {
    server.close(1011, 'upstream init failed');
    return new Response(null, { status: 101, webSocket: client });
  }

  const clientQueue = [];
  let upstreamReady = false;

  server.addEventListener('message', ({ data }) => {
    if (upstreamReady) {
      try { upstream.send(data); } catch (_) {}
    } else {
      clientQueue.push(data);
    }
  });
  server.addEventListener('close', ({ code, reason }) => {
    try { upstream.close(code || 1000, reason || ''); } catch (_) {}
  });
  server.addEventListener('error', () => {
    try { upstream.close(1011, 'client error'); } catch (_) {}
  });

  upstream.addEventListener('open', () => {
    upstreamReady = true;
    for (const data of clientQueue) {
      try { upstream.send(data); } catch (_) { break; }
    }
    clientQueue.length = 0;
  });
  upstream.addEventListener('message', ({ data }) => {
    try { server.send(data); } catch (_) {}
  });
  upstream.addEventListener('close', ({ code, reason }) => {
    try { server.close(code || 1000, reason || ''); } catch (_) {}
  });
  upstream.addEventListener('error', () => {
    try { server.close(1011, 'upstream error'); } catch (_) {}
  });

  return new Response(null, { status: 101, webSocket: client });
}

// ── Profile / UI generators ───────────────────────────────────────────────────

function makeDNSMobileconfig(host) {
  const rootId = crypto.randomUUID(), payloadId = crypto.randomUUID();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadDisplayName</key><string>DNS через prox</string>
  <key>PayloadIdentifier</key><string>com.prox.dns.${rootId}</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${rootId}</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadDisplayName</key><string>DNS Settings</string>
      <key>PayloadIdentifier</key><string>com.prox.dns.settings.${payloadId}</string>
      <key>PayloadType</key><string>com.apple.dnsSettings.managed</string>
      <key>PayloadUUID</key><string>${payloadId}</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>DNSSettings</key>
      <dict>
        <key>DNSProtocol</key><string>HTTPS</string>
        <key>ServerURL</key><string>https://dns.google/dns-query</string>
        <key>ServerAddresses</key>
        <array><string>8.8.8.8</string><string>8.8.4.4</string></array>
      </dict>
    </dict>
  </array>
</dict>
</plist>`;
}

function makePAC(host) {
  return `function FindProxyForURL(url, host) {
  if (isPlainHostName(host)) return "DIRECT";
  if (host === "127.0.0.1" || host === "localhost") return "DIRECT";
  if (isInNet(host, "10.0.0.0", "255.0.0.0")) return "DIRECT";
  if (isInNet(host, "172.16.0.0", "255.240.0.0")) return "DIRECT";
  if (isInNet(host, "192.168.0.0", "255.255.0.0")) return "DIRECT";
  return "HTTPS ${host}:443";
}
`;
}

function makeMobileconfig(host, user, pass) {
  const rootId = crypto.randomUUID(), payloadId = crypto.randomUUID();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadDisplayName</key><string>prox</string>
  <key>PayloadIdentifier</key><string>com.prox.cf.${rootId}</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${rootId}</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadDisplayName</key><string>Global HTTP Proxy</string>
      <key>PayloadIdentifier</key><string>com.prox.proxy.${payloadId}</string>
      <key>PayloadType</key><string>com.apple.proxy.http.global</string>
      <key>PayloadUUID</key><string>${payloadId}</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>ProxyType</key><string>Auto</string>
      <key>ProxyPACURL</key><string>https://${host}/pac</string>
      <key>ProxyUsername</key><string>${user}</string>
      <key>ProxyPassword</key><string>${pass}</string>
      <key>ProxyCaptiveLoginAllowed</key><true/>
      <key>ProxyPACFallbackAllowed</key><true/>
    </dict>
  </array>
</dict>
</plist>`;
}

function makeUI(host, user, pass, vlessUuid) {
  const base = `https://${host}`;
  const vlessCF = vlessUuid
    ? `vless://${vlessUuid}@${host}:443?encryption=none&security=tls&type=ws&path=%2Fvless&host=${host}#prox-cf`
    : '';
  const vlessRailway = vlessUuid
    ? `vless://${vlessUuid}@${RAILWAY_HOST}:443?encryption=none&security=tls&type=ws&path=%2Fvless&host=${RAILWAY_HOST}#prox-railway`
    : '';

  return `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>prox</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,system-ui,sans-serif;background:#f2f2f7;color:#1c1c1e}
.w{max-width:480px;margin:0 auto;padding:32px 16px}
h1{font-size:28px;font-weight:700;margin-bottom:6px}
.sub{font-size:15px;color:#8e8e93;margin-bottom:24px}
.c{background:white;border-radius:16px;padding:20px;margin-bottom:16px}
.c h2{font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#8e8e93;margin-bottom:4px}
.h2sub{font-size:12px;color:#8e8e93;margin-bottom:12px}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;margin-left:6px;vertical-align:middle}
.badge.green{background:#d1f5db;color:#1a7f37}
.badge.orange{background:#fff3cd;color:#856404}
.r{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f2f2f7}
.r:last-child{border-bottom:none}
.l{color:#8e8e93;font-size:15px}
.v{font-family:monospace;font-size:13px;font-weight:500;word-break:break-all;text-align:right;max-width:65%}
.btn{display:block;width:100%;padding:14px;background:#34C759;color:white;border:none;
  border-radius:12px;text-align:center;font-size:16px;font-weight:600;margin-top:12px;cursor:pointer}
.btn.blue{background:#007AFF}.btn.grey{background:#8e8e93}
.link{background:#f2f2f7;border-radius:10px;padding:10px 12px;font-family:monospace;
  font-size:11px;word-break:break-all;margin:12px 0;color:#1c1c1e;user-select:all;line-height:1.5}
ol{list-style:none;counter-reset:s}
li{counter-increment:s;padding:8px 0 8px 36px;position:relative;border-bottom:1px solid #f2f2f7;font-size:15px}
li:last-child{border-bottom:none}
li::before{content:counter(s);position:absolute;left:0;top:8px;background:#34C759;color:white;
  width:24px;height:24px;border-radius:12px;display:flex;align-items:center;justify-content:center;
  font-size:13px;font-weight:700}
.note{font-size:13px;color:#8e8e93;margin-top:8px}
</style></head><body>
<div class="w">
<h1>prox</h1>
<p class="sub">Обход блокировок</p>

${vlessCF ? `
<div class="c">
  <h2>Cloudflare <span class="badge green">Рекомендуется</span></h2>
  <p class="h2sub">Через Cloudflare Edge — IP Cloudflare не блокируются</p>
  <ol>
    <li>Скачай <b>V2Box</b> из App Store — бесплатно</li>
    <li>Нажми кнопку ниже — ссылка скопируется</li>
    <li>Открой V2Box → <b>+</b> → <b>Import from clipboard</b></li>
    <li>Появится «prox-cf» → нажми <b>Connect</b></li>
    <li>Разреши VPN — готово</li>
  </ol>
  <div class="link" id="vcf">${vlessCF}</div>
  <button class="btn" onclick="copy('vcf',this,'Скопировать Cloudflare')">Скопировать Cloudflare</button>
  <p class="note">Трафик: телефон → Cloudflare Edge → Railway → интернет. Без лимитов.</p>
</div>` : `<div class="c"><p style="color:#8e8e93">Загрузка...</p></div>`}

${vlessRailway ? `
<div class="c">
  <h2>Railway <span class="badge orange">Резерв</span></h2>
  <p class="h2sub">Прямое подключение к серверу — если Cloudflare заблокирован</p>
  <div class="link" id="vrw">${vlessRailway}</div>
  <button class="btn grey" onclick="copy('vrw',this,'Скопировать Railway')">Скопировать Railway</button>
</div>` : ''}

<div class="c">
  <h2>DNS профиль (дополнительно)</h2>
  <p style="font-size:14px;color:#3c3c43;margin-bottom:12px">Шифрует DNS запросы. Установи вместе с VPN.</p>
  <a href="${base}/dns.mobileconfig" class="btn blue" style="display:block;text-align:center;text-decoration:none;color:white;padding:14px;border-radius:12px;font-size:16px;font-weight:600;margin-top:0">Скачать DNS профиль</a>
</div>

<div class="c">
  <h2>Параметры</h2>
  <div class="r"><span class="l">CF host</span><span class="v">${host}</span></div>
  <div class="r"><span class="l">Railway host</span><span class="v">${RAILWAY_HOST}</span></div>
  ${vlessUuid ? `<div class="r"><span class="l">UUID</span><span class="v">${vlessUuid}</span></div>` : ''}
  <div class="r"><span class="l">Протокол</span><span class="v">VLESS+WS+TLS</span></div>
  <div class="r"><span class="l">Путь</span><span class="v">/vless</span></div>
  <div class="r"><span class="l">Порт</span><span class="v">443</span></div>
</div>
</div>
<script>
function copy(id,btn,label){
  navigator.clipboard.writeText(document.getElementById(id).innerText)
    .then(()=>{btn.textContent='Скопировано ✓';setTimeout(()=>btn.textContent=label,2000)});
}
</script>
</body></html>`;
}
