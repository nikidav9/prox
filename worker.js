/**
 * Cloudflare Worker — VLESS/WebSocket proxy + DNS-over-HTTPS + iOS profiles
 */
import { connect } from 'cloudflare:sockets';

const REALM = 'prox';

export default {
  async fetch(request, env) {
    const PROXY_USER = env.PROXY_USER || 'user';
    const PROXY_PASS = env.PROXY_PASS || 'changeme';
    const VLESS_UUID = env.VLESS_UUID || '';
    const url = new URL(request.url);
    const host = request.headers.get('host') || url.host;

    // ── VLESS over WebSocket ──────────────────────────────────────────────────
    if (url.pathname === '/vless') {
      if (!VLESS_UUID) return new Response('Not configured', { status: 503 });
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('WebSocket required', { status: 400 });
      }
      return handleVless(request, VLESS_UUID);
    }

    // ── Desktop tunnel (WebSocket proxy for PC app) ──────────────────────────
    if (url.pathname === '/tunnel') {
      if (!VLESS_UUID) return new Response('Not configured', { status: 503 });
      const token = url.searchParams.get('token') || '';
      if (token !== VLESS_UUID) return new Response('Unauthorized', { status: 401 });
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('WebSocket required', { status: 400 });
      }
      return handleTunnel(request);
    }

    // ── DNS-over-HTTPS (GET and POST) ─────────────────────────────────────────
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

    // ── Management routes (no auth) ───────────────────────────────────────────
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

    // ── Proxy auth ────────────────────────────────────────────────────────────
    if (!checkAuth(request.headers.get('proxy-authorization'), PROXY_USER, PROXY_PASS)) {
      return new Response('Proxy Authentication Required', {
        status: 407,
        headers: { 'proxy-authenticate': `Basic realm="${REALM}"` },
      });
    }

    // ── HTTPS CONNECT ─────────────────────────────────────────────────────────
    if (request.method === 'CONNECT') {
      const [targetHost, targetPort] = request.url.split(':');
      const port = parseInt(targetPort || '443', 10);
      try {
        const socket = connect({ hostname: targetHost, port });
        if (request.body) request.body.pipeTo(socket.writable).catch(() => {});
        return new Response(socket.readable, {
          status: 200,
          statusText: 'Connection Established',
        });
      } catch (err) {
        return new Response('Tunnel failed: ' + err.message, { status: 502 });
      }
    }

    // ── Plain HTTP proxy ──────────────────────────────────────────────────────
    if (request.url.startsWith('http://') || request.url.startsWith('https://')) {
      const headers = new Headers(request.headers);
      headers.delete('proxy-authorization');
      headers.delete('proxy-connection');
      try {
        return await fetch(request.url, {
          method: request.method,
          headers,
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
          redirect: 'follow',
        });
      } catch (err) {
        return new Response('Upstream error: ' + err.message, { status: 502 });
      }
    }

    return new Response('Bad Request', { status: 400 });
  },
};

// ── VLESS handler ─────────────────────────────────────────────────────────────

async function handleVless(request, uuid) {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  processVless(server, uuid).catch(() => { try { server.close(1011, 'err'); } catch (_) {} });
  return new Response(null, { status: 101, webSocket: client });
}

async function processVless(ws, uuid) {
  const q = new MsgQueue();
  ws.addEventListener('message', ({ data }) => {
    q.push(data instanceof ArrayBuffer ? new Uint8Array(data)
         : typeof data === 'string'    ? new TextEncoder().encode(data)
         : data);
  });
  ws.addEventListener('close', () => q.done());
  ws.addEventListener('error', () => q.done());

  // Accumulate bytes until header is complete
  let buf = new Uint8Array(0);
  const grow = (chunk) => { const n = new Uint8Array(buf.length + chunk.length); n.set(buf); n.set(chunk, buf.length); buf = n; };
  const fill = async (need) => { while (buf.length < need) { const c = await q.next(); if (!c) throw new Error('closed'); grow(c); } };

  await fill(18); // version(1) + uuid(16) + addLen(1)
  let i = 1; // skip version

  // Verify UUID
  const exp = hexToBytes(uuid.replace(/-/g, ''));
  for (let j = 0; j < 16; j++) if (buf[i + j] !== exp[j]) { ws.close(1003, 'auth'); return; }
  i += 16;

  const addLen = buf[i++];
  await fill(i + addLen + 4); // skip addinfo + cmd(1) + port(2) + addrType(1)
  i += addLen;

  const cmd = buf[i++];
  if (cmd !== 1) { ws.close(1003, 'udp'); return; }

  const port = (buf[i] << 8) | buf[i + 1]; i += 2;
  const addrType = buf[i++];

  let host;
  if (addrType === 1) {
    await fill(i + 4);
    host = Array.from(buf.slice(i, i + 4)).join('.'); i += 4;
  } else if (addrType === 2) {
    await fill(i + 1);
    const dl = buf[i++];
    await fill(i + dl);
    host = new TextDecoder().decode(buf.slice(i, i + dl)); i += dl;
  } else if (addrType === 3) {
    await fill(i + 16);
    host = '[' + [...Array(8)].map((_, j) => ((buf[i+j*2]<<8)|buf[i+j*2+1]).toString(16)).join(':') + ']';
    i += 16;
  } else { ws.close(1003, 'addr'); return; }

  let remote;
  try { remote = connect({ hostname: host, port }); }
  catch { ws.close(1011, 'connect'); return; }

  // VLESS response: version=0, addLen=0
  ws.send(new Uint8Array([0, 0]));

  const leftover = buf.slice(i);

  // WS → Remote
  const toRemote = (async () => {
    const w = remote.writable.getWriter();
    try {
      if (leftover.length) await w.write(leftover);
      while (true) { const c = await q.next(); if (!c) break; await w.write(c); }
    } catch (_) {}
    try { w.close(); } catch (_) {}
  })();

  // Remote → WS
  const toWS = (async () => {
    const r = remote.readable.getReader();
    try { while (true) { const { done, value } = await r.read(); if (done) break; ws.send(value); } }
    catch (_) {}
    try { ws.close(); } catch (_) {}
  })();

  await Promise.allSettled([toRemote, toWS]);
}

// ── Desktop tunnel handler ────────────────────────────────────────────────────

async function handleTunnel(request) {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  processTunnel(server).catch(() => { try { server.close(1011, 'err'); } catch (_) {} });
  return new Response(null, { status: 101, webSocket: client });
}

async function processTunnel(ws) {
  const q = new MsgQueue();
  ws.addEventListener('message', ({ data }) => {
    q.push(data instanceof ArrayBuffer ? new Uint8Array(data)
         : typeof data === 'string'    ? new TextEncoder().encode(data)
         : data);
  });
  ws.addEventListener('close', () => q.done());
  ws.addEventListener('error', () => q.done());

  // First message: JSON {"host":"...", "port":N}
  const headerChunk = await q.next();
  if (!headerChunk) return;
  let hdr;
  try { hdr = JSON.parse(new TextDecoder().decode(headerChunk)); }
  catch { ws.close(1003, 'bad header'); return; }

  const { host, port } = hdr;
  if (!host || !port) { ws.close(1003, 'missing fields'); return; }

  let remote;
  try { remote = connect({ hostname: host, port }); }
  catch (e) {
    ws.send(JSON.stringify({ ok: false, error: e.message }));
    ws.close();
    return;
  }

  ws.send(JSON.stringify({ ok: true }));

  const toRemote = (async () => {
    const w = remote.writable.getWriter();
    try {
      while (true) { const c = await q.next(); if (!c) break; await w.write(c); }
    } catch (_) {}
    try { w.close(); } catch (_) {}
  })();

  const toWS = (async () => {
    const r = remote.readable.getReader();
    try { while (true) { const { done, value } = await r.read(); if (done) break; ws.send(value); } }
    catch (_) {}
    try { ws.close(); } catch (_) {}
  })();

  await Promise.allSettled([toRemote, toWS]);
}

class MsgQueue {
  constructor() { this.q = []; this.r = null; this.end = false; }
  push(v) { this.r ? (this.r(v), this.r = null) : this.q.push(v); }
  done() { this.end = true; this.r && (this.r(null), this.r = null); }
  next() {
    if (this.q.length) return Promise.resolve(this.q.shift());
    if (this.end) return Promise.resolve(null);
    return new Promise(r => { this.r = r; });
  }
}

function hexToBytes(hex) {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i*2, i*2+2), 16);
  return b;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function checkAuth(header, user, pass) {
  if (!header) return false;
  const [type, creds] = (header || '').split(' ');
  if (type !== 'Basic') return false;
  const decoded = atob(creds || '');
  const colon = decoded.indexOf(':');
  if (colon === -1) return false;
  return decoded.slice(0, colon) === user && decoded.slice(colon + 1) === pass;
}

// ── Generators ────────────────────────────────────────────────────────────────

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
        <array>
          <string>8.8.8.8</string>
          <string>8.8.4.4</string>
        </array>
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
  const vlessUrl = vlessUuid
    ? `vless://${vlessUuid}@${host}:443?encryption=none&security=tls&type=ws&path=%2Fvless&host=${host}#prox`
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
.c h2{font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#8e8e93;margin-bottom:12px}
.r{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f2f2f7}
.r:last-child{border-bottom:none}
.l{color:#8e8e93;font-size:15px}.v{font-family:monospace;font-size:13px;font-weight:500;word-break:break-all;text-align:right;max-width:65%}
.btn{display:block;width:100%;padding:14px;background:#34C759;color:white;border:none;
  border-radius:12px;text-align:center;font-size:16px;font-weight:600;margin-top:12px;cursor:pointer}
.btn.blue{background:#007AFF}
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
<p class="sub">Обход блокировок — Cloudflare, бесплатно</p>

${vlessUrl ? `
<div class="c">
  <h2>VPN через V2Box</h2>
  <ol>
    <li>Скачай <b>V2Box</b> из App Store — бесплатно</li>
    <li>Нажми кнопку ниже — ссылка скопируется</li>
    <li>Открой V2Box → <b>+</b> → <b>Import from clipboard</b></li>
    <li>Появится «prox» → нажми <b>Connect</b></li>
    <li>Разреши VPN — готово</li>
  </ol>
  <div class="link" id="vl">${vlessUrl}</div>
  <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('vl').innerText).then(()=>{this.textContent='Скопировано ✓';setTimeout(()=>this.textContent='Скопировать ссылку',2000)})">Скопировать ссылку</button>
  <p class="note">Весь трафик через Cloudflare. Wi-Fi и мобильная сеть.</p>
</div>` : `<div class="c"><p style="color:#8e8e93">Загрузка...</p></div>`}

<div class="c">
  <h2>DNS профиль (дополнительно)</h2>
  <p style="font-size:14px;color:#3c3c43;margin-bottom:12px">Шифрует DNS запросы. Установи вместе с VPN для максимального обхода.</p>
  <a href="${base}/dns.mobileconfig" class="btn blue" style="display:block;text-align:center;text-decoration:none;color:white;padding:14px;border-radius:12px;font-size:16px;font-weight:600">Скачать DNS профиль</a>
</div>

<div class="c">
  <h2>Параметры (для ручной настройки)</h2>
  <div class="r"><span class="l">Адрес</span><span class="v">${host}</span></div>
  ${vlessUuid ? `<div class="r"><span class="l">UUID</span><span class="v">${vlessUuid}</span></div>` : ''}
  <div class="r"><span class="l">Протокол</span><span class="v">VLESS+WS+TLS</span></div>
  <div class="r"><span class="l">Путь</span><span class="v">/vless</span></div>
  <div class="r"><span class="l">Порт</span><span class="v">443</span></div>
</div>
</div></body></html>`;
}
