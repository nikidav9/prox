/**
 * Cloudflare Worker — VLESS over WebSocket
 * Uses cloudflare:sockets for direct TCP tunneling.
 * UDP DNS queries are resolved via DNS-over-HTTPS (Google/Cloudflare).
 */

import { connect } from 'cloudflare:sockets';

const DEFAULT_UUID = 'f03e5c9e-16ae-484e-a405-c78695b1142a';

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (e) {
      return new Response('Worker error: ' + e.message, { status: 500 });
    }
  },
};

async function handleRequest(request, env) {
  const uuid = env.VLESS_UUID || DEFAULT_UUID;
  const reqUrl = new URL(request.url);
  const host = request.headers.get('host') || reqUrl.host;

  if (reqUrl.pathname === '/vless' &&
      request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    return vlessOverWS(request, uuid);
  }

  if (reqUrl.pathname === '/') {
    return new Response(makeUI(host, uuid), {
      headers: { 'content-type': 'text/html;charset=utf-8' },
    });
  }

  if (reqUrl.pathname === '/pac') {
    return new Response(makePAC(host), {
      headers: { 'content-type': 'application/x-ns-proxy-autoconfig' },
    });
  }

  if (reqUrl.pathname === '/dns.mobileconfig') {
    return new Response(makeDNSMobileconfig(host), {
      headers: {
        'content-type': 'application/x-apple-aspen-config',
        'content-disposition': 'attachment; filename="dns-prox.mobileconfig"',
      },
    });
  }

  return new Response('Not Found', { status: 404 });
}

// ─── VLESS over WebSocket ────────────────────────────────────────────────────

async function vlessOverWS(request, uuid) {
  const pair = new WebSocketPair();
  const [client, ws] = Object.values(pair);
  ws.accept();
  // Without this the runtime delivers binary frames as Blob, and the
  // synchronous Uint8Array conversion in wsReadableStream yields zero bytes.
  try { ws.binaryType = 'arraybuffer'; } catch (_) {}

  const wsStream = wsReadableStream(ws);

  let remoteSocket = { value: null };
  let udpWrite = null;
  let isDns = false;

  wsStream
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          // After header is parsed, route to TCP or DNS
          if (isDns && udpWrite) {
            return udpWrite(chunk);
          }
          if (remoteSocket.value) {
            const w = remoteSocket.value.writable.getWriter();
            await w.write(chunk);
            w.releaseLock();
            return;
          }

          // First chunk: parse VLESS header
          const parsed = parseVlessHeader(chunk, uuid);
          if (parsed.error) {
            throw new Error(parsed.error);
          }

          const { version, address, port, rawDataIndex, isUDP } = parsed;
          const responseHeader = new Uint8Array([version, 0]);
          const initialPayload = chunk.slice(rawDataIndex);

          if (isUDP) {
            if (port !== 53) throw new Error('UDP only allowed for DNS (port 53)');
            isDns = true;
            udpWrite = await startDNS(ws, responseHeader);
            if (initialPayload.byteLength > 0) udpWrite(initialPayload);
            return;
          }

          // TCP
          connectTCP(remoteSocket, address, port, initialPayload, ws, responseHeader);
        },
        close() {},
        abort() { safeClose(ws); },
      })
    )
    .catch(() => safeClose(ws));

  return new Response(null, { status: 101, webSocket: client });
}

// Build a ReadableStream from WebSocket messages
function wsReadableStream(ws) {
  return new ReadableStream({
    start(controller) {
      // Blob conversion is async, so chain every frame through one promise to
      // keep them in wire order — reordering would corrupt the VLESS stream.
      let queue = Promise.resolve();
      const push = (fn) => { queue = queue.then(fn).catch(() => {}); };

      ws.addEventListener('message', ({ data }) => {
        push(async () => {
          let bytes;
          if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
          else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          else if (typeof data === 'string') bytes = new TextEncoder().encode(data);
          else if (data && typeof data.arrayBuffer === 'function') bytes = new Uint8Array(await data.arrayBuffer());
          else return;
          if (bytes.byteLength > 0) controller.enqueue(bytes);
        });
      });
      ws.addEventListener('close', () => {
        push(() => { try { controller.close(); } catch (_) {} });
      });
      ws.addEventListener('error', () => {
        push(() => { try { controller.error(new Error('ws error')); } catch (_) {} });
      });
    },
    cancel() { safeClose(ws); },
  });
}

// Establish outbound TCP connection and relay data
async function connectTCP(remoteSocket, address, port, initialPayload, ws, responseHeader) {
  try {
    const tcp = connect({ hostname: address, port });
    remoteSocket.value = tcp;

    // Write initial payload (the data that came with the VLESS header)
    if (initialPayload.byteLength > 0) {
      const w = tcp.writable.getWriter();
      await w.write(initialPayload);
      w.releaseLock();
    }

    // Pipe TCP → WebSocket; prepend VLESS response header to the very first chunk
    let headerSent = false;
    await tcp.readable
      .pipeTo(
        new WritableStream({
          write(chunk) {
            if (ws.readyState !== 1 /* OPEN */) return;
            if (!headerSent) {
              headerSent = true;
              const combined = new Uint8Array(responseHeader.byteLength + chunk.byteLength);
              combined.set(responseHeader, 0);
              combined.set(chunk, responseHeader.byteLength);
              ws.send(combined);
            } else {
              ws.send(chunk);
            }
          },
          close() {},
          abort() {},
        })
      )
      .catch(() => {});

  } catch (e) {
    safeClose(ws);
  } finally {
    safeClose(ws);
  }
}

// Handle UDP DNS via DNS-over-HTTPS
async function startDNS(ws, responseHeader) {
  let headerSent = false;

  const write = async (chunk) => {
    // VLESS UDP: each packet prefixed with 2-byte big-endian length
    let offset = 0;
    while (offset < chunk.byteLength) {
      const pktLen = (chunk[offset] << 8) | chunk[offset + 1];
      offset += 2;
      const dnsQuery = chunk.slice(offset, offset + pktLen);
      offset += pktLen;
      if (pktLen === 0) continue;

      try {
        const resp = await fetch('https://cloudflare-dns.com/dns-query', {
          method: 'POST',
          headers: { 'content-type': 'application/dns-message' },
          body: dnsQuery,
        });
        const body = await resp.arrayBuffer();
        const bodyBytes = new Uint8Array(body);

        // 2-byte length prefix + DNS response body
        const lenBuf = new Uint8Array(2);
        lenBuf[0] = bodyBytes.byteLength >> 8;
        lenBuf[1] = bodyBytes.byteLength & 0xff;

        if (ws.readyState !== 1) return;

        if (!headerSent) {
          headerSent = true;
          const combined = new Uint8Array(
            responseHeader.byteLength + lenBuf.byteLength + bodyBytes.byteLength
          );
          combined.set(responseHeader, 0);
          combined.set(lenBuf, responseHeader.byteLength);
          combined.set(bodyBytes, responseHeader.byteLength + lenBuf.byteLength);
          ws.send(combined);
        } else {
          const combined = new Uint8Array(lenBuf.byteLength + bodyBytes.byteLength);
          combined.set(lenBuf, 0);
          combined.set(bodyBytes, lenBuf.byteLength);
          ws.send(combined);
        }
      } catch (_) {}
    }
  };

  return write;
}

function safeClose(ws) {
  try { if (ws.readyState < 2) ws.close(); } catch (_) {}
}

// ─── VLESS header parser ─────────────────────────────────────────────────────

function parseVlessHeader(data, uuid) {
  if (data.byteLength < 24) return { error: 'header too short' };

  const version = data[0];

  const rxUUID = bytesToUUID(data.slice(1, 17));
  if (rxUUID !== uuid) return { error: 'invalid UUID' };

  let offset = 17;
  const addonLen = data[offset++];
  offset += addonLen;

  const cmd = data[offset++];
  const isUDP = cmd === 0x02;
  if (cmd !== 0x01 && cmd !== 0x02) return { error: `unsupported cmd 0x${cmd.toString(16)}` };

  const port = (data[offset] << 8) | data[offset + 1];
  offset += 2;

  const addrType = data[offset++];
  let address;

  if (addrType === 0x01) {
    // IPv4
    address = `${data[offset]}.${data[offset+1]}.${data[offset+2]}.${data[offset+3]}`;
    offset += 4;
  } else if (addrType === 0x02) {
    // Domain
    const len = data[offset++];
    address = new TextDecoder().decode(data.slice(offset, offset + len));
    offset += len;
  } else if (addrType === 0x03) {
    // IPv6
    const parts = [];
    for (let i = 0; i < 8; i++) {
      parts.push(((data[offset + i*2] << 8) | data[offset + i*2 + 1]).toString(16));
    }
    address = `[${parts.join(':')}]`;
    offset += 16;
  } else {
    return { error: `unknown addr type ${addrType}` };
  }

  return { version, address, port, rawDataIndex: offset, isUDP };
}

function bytesToUUID(b) {
  const h = Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

// ─── UI & profiles ───────────────────────────────────────────────────────────

function makePAC(host) {
  return `function FindProxyForURL(url, host) {
  if (isPlainHostName(host)) return "DIRECT";
  if (host === "127.0.0.1" || host === "localhost") return "DIRECT";
  if (isInNet(host, "10.0.0.0", "255.0.0.0")) return "DIRECT";
  if (isInNet(host, "172.16.0.0", "255.240.0.0")) return "DIRECT";
  if (isInNet(host, "192.168.0.0", "255.255.0.0")) return "DIRECT";
  return "HTTPS ${host}:443";
}`;
}

function makeDNSMobileconfig(host) {
  const rootId = crypto.randomUUID(), pid = crypto.randomUUID();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>PayloadDisplayName</key><string>DNS prox</string>
  <key>PayloadIdentifier</key><string>com.prox.dns.${rootId}</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${rootId}</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadContent</key><array><dict>
    <key>PayloadDisplayName</key><string>DNS Settings</string>
    <key>PayloadIdentifier</key><string>com.prox.dns.s.${pid}</string>
    <key>PayloadType</key><string>com.apple.dnsSettings.managed</string>
    <key>PayloadUUID</key><string>${pid}</string>
    <key>PayloadVersion</key><integer>1</integer>
    <key>DNSSettings</key><dict>
      <key>DNSProtocol</key><string>HTTPS</string>
      <key>ServerURL</key><string>https://cloudflare-dns.com/dns-query</string>
      <key>ServerAddresses</key><array><string>1.1.1.1</string><string>1.0.0.1</string></array>
    </dict>
  </dict></array>
</dict></plist>`;
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
  <p class="note">Трафик: телефон → Cloudflare → интернет. Без лимитов.</p>
</div>

<div class="c">
  <h2>DNS профиль (рекомендуется)</h2>
  <p style="font-size:14px;color:#3c3c43;margin-bottom:12px">Шифрует DNS запросы — установи вместе с VPN для надёжной работы.</p>
  <a href="/dns.mobileconfig" class="btn blue" style="text-decoration:none;color:white;display:block;padding:14px;text-align:center;border-radius:12px;font-size:16px;font-weight:600;margin-top:0">Скачать DNS профиль</a>
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
