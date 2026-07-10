/**
 * Cloudflare Worker — VLESS over WebSocket
 * Handles VLESS protocol directly using cloudflare:sockets (no backend needed)
 */

import { connect } from 'cloudflare:sockets';

const VLESS_UUID = 'f03e5c9e-16ae-484e-a405-c78695b1142a';

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
  const uuid = env.VLESS_UUID || VLESS_UUID;
  const url  = new URL(request.url);
  const host = request.headers.get('host') || url.host;

  // ── VLESS WebSocket ───────────────────────────────────────────────────────
  if (url.pathname === '/vless') {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket required', { status: 400 });
    }
    return handleVlessWS(request, uuid);
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
      return new Response(makeUI(host, uuid), {
        headers: { 'content-type': 'text/html;charset=utf-8' },
      });
    }
  }

  return new Response('Not Found', { status: 404 });
}

// ── VLESS over WebSocket handler ─────────────────────────────────────────────

async function handleVlessWS(request, uuid) {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();

  let tcpSocket = null;
  let remoteWriter = null;
  let headerParsed = false;

  const wsStream = new ReadableStream({
    start(controller) {
      server.addEventListener('message', ({ data }) => {
        try {
          const buf = data instanceof ArrayBuffer ? data
            : typeof data === 'string' ? new TextEncoder().encode(data).buffer
            : data;
          controller.enqueue(new Uint8Array(buf));
        } catch (_) {}
      });
      server.addEventListener('close',  () => { try { controller.close(); } catch (_) {} });
      server.addEventListener('error',  () => { try { controller.error(new Error('ws')); } catch (_) {} });
    },
    cancel() { safeCloseWS(server); }
  });

  wsStream.pipeTo(new WritableStream({
    async write(chunk) {
      if (!headerParsed) {
        headerParsed = true;

        const parsed = parseVlessHeader(chunk, uuid);
        if ('error' in parsed) {
          safeCloseWS(server, 1002, parsed.error);
          return;
        }

        const { version, remoteHost, remotePort, payload } = parsed;

        try {
          tcpSocket = connect({ hostname: remoteHost, port: remotePort });
          remoteWriter = tcpSocket.writable.getWriter();

          // VLESS response: [version, 0]
          server.send(new Uint8Array([version, 0]));

          if (payload.byteLength > 0) {
            await remoteWriter.write(payload);
          }

          // Pipe remote TCP → WebSocket
          (async () => {
            try {
              const reader = tcpSocket.readable.getReader();
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                try { server.send(value); } catch (_) { break; }
              }
              reader.releaseLock();
            } finally {
              safeCloseWS(server);
            }
          })().catch(() => safeCloseWS(server));

        } catch (e) {
          safeCloseWS(server, 1011, String(e));
        }

      } else if (remoteWriter) {
        try {
          await remoteWriter.write(chunk);
        } catch (_) {
          safeCloseWS(server);
        }
      }
    },
    close() {
      try { remoteWriter?.releaseLock(); } catch (_) {}
      try { tcpSocket?.close(); } catch (_) {}
    },
    abort() {
      try { remoteWriter?.releaseLock(); } catch (_) {}
      try { tcpSocket?.close(); } catch (_) {}
    }
  })).catch(() => {
    safeCloseWS(server);
    try { tcpSocket?.close(); } catch (_) {}
  });

  return new Response(null, { status: 101, webSocket: client });
}

function safeCloseWS(ws, code = 1000, reason = '') {
  try {
    if (ws.readyState === 1 || ws.readyState === 2) ws.close(code, reason);
  } catch (_) {}
}

// ── VLESS header parser ───────────────────────────────────────────────────────

function parseVlessHeader(data, uuid) {
  if (data.byteLength < 24) return { error: 'header too short' };

  let offset = 0;
  const version = data[offset++];

  // UUID: bytes 1–16
  const uuidStr = bytesToUUID(data.slice(1, 17));
  offset = 17;
  if (uuidStr !== uuid) return { error: 'invalid uuid' };

  // Addon
  const addonLen = data[offset++];
  offset += addonLen;

  // Command: 0x01=TCP, 0x02=UDP
  const cmd = data[offset++];
  if (cmd !== 0x01 && cmd !== 0x02) return { error: `unsupported cmd: ${cmd}` };

  // Port (2 bytes big-endian)
  const remotePort = (data[offset] << 8) | data[offset + 1];
  offset += 2;

  // Address
  const addrType = data[offset++];
  let remoteHost;

  if (addrType === 0x01) {
    remoteHost = `${data[offset]}.${data[offset+1]}.${data[offset+2]}.${data[offset+3]}`;
    offset += 4;
  } else if (addrType === 0x02) {
    const len = data[offset++];
    remoteHost = new TextDecoder().decode(data.slice(offset, offset + len));
    offset += len;
  } else if (addrType === 0x03) {
    const parts = [];
    for (let i = 0; i < 8; i++) {
      parts.push(((data[offset + i*2] << 8) | data[offset + i*2 + 1]).toString(16));
    }
    remoteHost = `[${parts.join(':')}]`;
    offset += 16;
  } else {
    return { error: `unknown addr type: ${addrType}` };
  }

  return { version, remoteHost, remotePort, payload: data.slice(offset) };
}

function bytesToUUID(b) {
  const h = Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
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

function makeUI(host, uuid) {
  const vlessLink = `vless://${uuid}@${host}:443?encryption=none&security=tls&type=ws&path=%2Fvless&host=${host}#prox`;

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
.l{color:#8e8e93;font-size:15px}
.v{font-family:monospace;font-size:13px;font-weight:500;word-break:break-all;text-align:right;max-width:65%}
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
<p class="sub">Обход блокировок</p>

<div class="c">
  <h2>Подключение через V2Box</h2>
  <ol>
    <li>Скачай <b>V2Box</b> из App Store — бесплатно</li>
    <li>Нажми кнопку ниже — ссылка скопируется</li>
    <li>Открой V2Box → <b>+</b> → <b>Import from clipboard</b></li>
    <li>Появится «prox» → нажми <b>Connect</b></li>
    <li>Разреши VPN — готово</li>
  </ol>
  <div class="link" id="vl">${vlessLink}</div>
  <button class="btn" onclick="copy('vl',this,'Скопировать ссылку')">Скопировать ссылку</button>
  <p class="note">Трафик: телефон → Cloudflare Edge → интернет. Без лимитов, без доп. сервера.</p>
</div>

<div class="c">
  <h2>DNS профиль (дополнительно)</h2>
  <p style="font-size:14px;color:#3c3c43;margin-bottom:12px">Шифрует DNS запросы. Установи вместе с VPN.</p>
  <a href="https://${host}/dns.mobileconfig" class="btn blue" style="text-decoration:none;color:white;display:block;padding:14px;text-align:center;border-radius:12px;font-size:16px;font-weight:600;margin-top:0">Скачать DNS профиль</a>
</div>

<div class="c">
  <h2>Параметры</h2>
  <div class="r"><span class="l">Host</span><span class="v">${host}</span></div>
  <div class="r"><span class="l">UUID</span><span class="v">${uuid}</span></div>
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
