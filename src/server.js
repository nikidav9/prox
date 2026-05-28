'use strict';

const http = require('http');
const net = require('net');
const url = require('url');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Railway injects PORT; fall back to 8080 for local/Docker use
const PORT = parseInt(process.env.PORT || '8080', 10);
const PROXY_USER = process.env.PROXY_USER || 'user';
const PROXY_PASS = process.env.PROXY_PASS || (() => {
  const f = path.join(__dirname, '../.proxy_pass');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const p = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(f, p);
  return p;
})();
const SERVER_HOST = process.env.SERVER_HOST || 'localhost';
// On Railway the external port is always 443 (HTTPS via their edge)
const EXTERNAL_PORT = process.env.EXTERNAL_PORT || PORT;
const XRAY_UUID = process.env.XRAY_UUID || '';
const XRAY_PORT = 8388;

// ── Auth ──────────────────────────────────────────────────────────────────────

function checkProxyAuth(req) {
  const auth = req.headers['proxy-authorization'];
  if (!auth) return false;
  const [type, creds] = auth.split(' ');
  if (type !== 'Basic') return false;
  const decoded = Buffer.from(creds, 'base64').toString();
  const colon = decoded.indexOf(':');
  if (colon === -1) return false;
  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);
  const uok = user.length === PROXY_USER.length &&
    crypto.timingSafeEqual(Buffer.from(user), Buffer.from(PROXY_USER));
  const pok = pass.length === PROXY_PASS.length &&
    crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(PROXY_PASS));
  return uok && pok;
}

// ── Single combined server ────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const reqUrl = url.parse(req.url);

  // ── Management routes (no auth needed) ──────────────────────────────────────
  if (reqUrl.pathname === '/profile.mobileconfig') {
    const profile = generateMobileconfig();
    res.writeHead(200, {
      'Content-Type': 'application/x-apple-aspen-config',
      'Content-Disposition': 'attachment; filename="prox.mobileconfig"',
    });
    res.end(profile);
    return;
  }

  if (reqUrl.pathname === '/pac') {
    res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' });
    res.end(generatePAC());
    return;
  }

  if (reqUrl.pathname === '/' || reqUrl.pathname === '') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(generateUI());
    return;
  }

  // ── HTTP proxy ───────────────────────────────────────────────────────────────
  if (!checkProxyAuth(req)) {
    res.writeHead(407, {
      'Proxy-Authenticate': 'Basic realm="prox"',
      'Content-Length': '0',
      'Connection': 'close',
    });
    res.end();
    return;
  }

  const target = url.parse(req.url);
  if (!target.hostname) {
    res.writeHead(400);
    res.end();
    return;
  }

  const options = {
    hostname: target.hostname,
    port: target.port || 80,
    path: target.path,
    method: req.method,
    headers: { ...req.headers },
  };
  delete options.headers['proxy-authorization'];
  delete options.headers['proxy-connection'];

  const upstream = http.request(options, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res, { end: true });
  });

  upstream.on('error', () => { try { res.end(); } catch (_) {} });
  req.pipe(upstream, { end: true });
});

// HTTPS CONNECT tunnel
server.on('connect', (req, socket, head) => {
  if (!checkProxyAuth(req)) {
    socket.write(
      'HTTP/1.1 407 Proxy Authentication Required\r\n' +
      'Proxy-Authenticate: Basic realm="prox"\r\n' +
      'Content-Length: 0\r\nConnection: close\r\n\r\n'
    );
    socket.destroy();
    return;
  }

  const [host, portStr] = req.url.split(':');
  const port = parseInt(portStr || '443', 10);

  const tunnel = net.connect(port, host, () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) tunnel.write(head);
    tunnel.pipe(socket, { end: true });
    socket.pipe(tunnel, { end: true });
  });

  tunnel.on('error', () => { try { socket.destroy(); } catch (_) {} });
  socket.on('error', () => { try { tunnel.destroy(); } catch (_) {} });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[prox] listening on :${PORT}`);
  console.log(`[prox] host=${SERVER_HOST} user=${PROXY_USER} pass=${PROXY_PASS}`);
  if (XRAY_UUID) console.log(`[prox] VLESS UUID=${XRAY_UUID}`);
  console.log(`[prox] UI → http://${SERVER_HOST}:${EXTERNAL_PORT}/`);
});

// WebSocket upgrade — proxy /vless path to local Xray
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/vless' || !XRAY_UUID) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const xray = net.connect(XRAY_PORT, '127.0.0.1', () => {
    let raw = `GET /vless HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    raw += '\r\n';
    xray.write(raw);
    if (head && head.length) xray.write(head);
    xray.pipe(socket);
    socket.pipe(xray);
  });

  xray.on('error', () => { try { socket.destroy(); } catch (_) {} });
  socket.on('error', () => { try { xray.destroy(); } catch (_) {} });
});

// ── Profile generators ────────────────────────────────────────────────────────

function generateMobileconfig() {
  const id = () => crypto.randomUUID();
  const payloadId = id();
  const rootId = id();
  // PAC URL — HTTPS if on Railway (external port 443), HTTP otherwise
  const scheme = EXTERNAL_PORT == 443 ? 'https' : 'http';
  const pacUrl = `${scheme}://${SERVER_HOST}${EXTERNAL_PORT == 443 ? '' : ':' + EXTERNAL_PORT}/pac`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadDisplayName</key>
  <string>prox</string>
  <key>PayloadIdentifier</key>
  <string>com.prox.config.${rootId}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${rootId}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadDisplayName</key>
      <string>Global HTTP Proxy</string>
      <key>PayloadIdentifier</key>
      <string>com.prox.proxy.${payloadId}</string>
      <key>PayloadType</key>
      <string>com.apple.proxy.http.global</string>
      <key>PayloadUUID</key>
      <string>${payloadId}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>ProxyType</key>
      <string>Auto</string>
      <key>ProxyPACURL</key>
      <string>${pacUrl}</string>
      <key>ProxyUsername</key>
      <string>${PROXY_USER}</string>
      <key>ProxyPassword</key>
      <string>${PROXY_PASS}</string>
      <key>ProxyCaptiveLoginAllowed</key>
      <true/>
      <key>ProxyPACFallbackAllowed</key>
      <true/>
    </dict>
  </array>
</dict>
</plist>`;
}

function generatePAC() {
  const scheme = EXTERNAL_PORT == 443 ? 'https' : 'http';
  const proxyDirective = EXTERNAL_PORT == 443
    ? `HTTPS ${SERVER_HOST}:443`
    : `PROXY ${SERVER_HOST}:${EXTERNAL_PORT}`;

  return `// PAC — generated by prox
function FindProxyForURL(url, host) {
  if (isPlainHostName(host)) return "DIRECT";
  if (host === "127.0.0.1" || host === "localhost") return "DIRECT";
  if (isInNet(host, "10.0.0.0", "255.0.0.0")) return "DIRECT";
  if (isInNet(host, "172.16.0.0", "255.240.0.0")) return "DIRECT";
  if (isInNet(host, "192.168.0.0", "255.255.0.0")) return "DIRECT";
  return "${proxyDirective}";
}
`;
}

function generateUI() {
  const scheme = EXTERNAL_PORT == 443 ? 'https' : 'http';
  const host443 = EXTERNAL_PORT == 443;
  const baseUrl = `${scheme}://${SERVER_HOST}${host443 ? '' : ':' + EXTERNAL_PORT}`;
  const vlessUrl = XRAY_UUID
    ? `vless://${XRAY_UUID}@${SERVER_HOST}:443?encryption=none&security=tls&type=ws&path=%2Fvless&host=${SERVER_HOST}#prox`
    : '';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>prox</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,system-ui,sans-serif;background:#f2f2f7;color:#1c1c1e}
  .w{max-width:480px;margin:0 auto;padding:32px 16px}
  h1{font-size:28px;font-weight:700;margin-bottom:8px}
  .sub{font-size:15px;color:#8e8e93;margin-bottom:24px}
  .c{background:white;border-radius:16px;padding:20px;margin-bottom:16px}
  .c h2{font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#8e8e93;margin-bottom:12px}
  .r{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f2f2f7}
  .r:last-child{border-bottom:none}
  .l{color:#8e8e93;font-size:15px}.v{font-family:monospace;font-size:14px;font-weight:500;word-break:break-all;text-align:right;max-width:65%}
  .btn{display:block;width:100%;padding:14px;background:#34C759;color:white;border:none;
    border-radius:12px;text-align:center;font-size:16px;font-weight:600;margin-bottom:12px;cursor:pointer}
  .link-box{background:#f2f2f7;border-radius:10px;padding:12px;font-family:monospace;
    font-size:11px;word-break:break-all;margin:12px 0;color:#1c1c1e;user-select:all}
  ol{list-style:none;counter-reset:s}
  li{counter-increment:s;padding:8px 0 8px 36px;position:relative;border-bottom:1px solid #f2f2f7;font-size:15px}
  li:last-child{border-bottom:none}
  li::before{content:counter(s);position:absolute;left:0;top:8px;background:#34C759;color:white;
    width:24px;height:24px;border-radius:12px;display:flex;align-items:center;justify-content:center;
    font-size:13px;font-weight:700}
  .note{font-size:13px;color:#8e8e93;margin-top:8px}
  .copied{background:#30D158!important}
</style>
</head>
<body>
<div class="w">
  <h1>prox</h1>
  <p class="sub">Обход блокировок через европейский сервер</p>

  ${vlessUrl ? `
  <div class="c">
    <h2>Подключение через V2Box</h2>
    <ol>
      <li>Скачай <b>V2Box</b> из App Store — бесплатно</li>
      <li>Нажми кнопку ниже, чтобы скопировать ссылку</li>
      <li>Открой V2Box → нажми <b>+</b> → <b>Import from clipboard</b></li>
      <li>Появится «prox» → нажми <b>Connect</b></li>
      <li>iOS спросит разрешение на VPN — разреши</li>
    </ol>
    <div class="link-box" id="vless">${vlessUrl}</div>
    <button class="btn" onclick="var b=document.getElementById('vless');navigator.clipboard.writeText(b.innerText).then(()=>{this.textContent='Скопировано!';this.classList.add('copied');setTimeout(()=>{this.textContent='Скопировать ссылку';this.classList.remove('copied')},2000)})">Скопировать ссылку</button>
    <p class="note">Весь трафик идёт через сервер. Работает на Wi-Fi и мобильной сети.</p>
  </div>` : `
  <div class="c">
    <h2>Сервер запускается...</h2>
    <p style="font-size:15px;color:#8e8e93">Подожди минуту и обнови страницу</p>
  </div>`}

  <div class="c">
    <h2>Параметры сервера</h2>
    <div class="r"><span class="l">Адрес</span><span class="v">${SERVER_HOST}</span></div>
    ${XRAY_UUID ? `<div class="r"><span class="l">UUID</span><span class="v">${XRAY_UUID}</span></div>` : ''}
    <div class="r"><span class="l">Протокол</span><span class="v">VLESS+WS+TLS</span></div>
    <div class="r"><span class="l">Путь</span><span class="v">/vless</span></div>
    <div class="r"><span class="l">Порт</span><span class="v">443</span></div>
  </div>
</div>
</body>
</html>`;
}
