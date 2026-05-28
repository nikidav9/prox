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
  console.log(`[prox] UI → http://${SERVER_HOST}:${EXTERNAL_PORT}/`);
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
  const baseUrl = `${scheme}://${SERVER_HOST}${EXTERNAL_PORT == 443 ? '' : ':' + EXTERNAL_PORT}`;

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>prox</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #f2f2f7; color: #1c1c1e; }
  .wrap { max-width: 480px; margin: 0 auto; padding: 32px 16px; }
  h1 { font-size: 28px; font-weight: 700; margin-bottom: 24px; }
  .card { background: white; border-radius: 16px; padding: 20px; margin-bottom: 16px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .5px; color: #8e8e93; margin-bottom: 12px; }
  .row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0;
         border-bottom: 1px solid #f2f2f7; }
  .row:last-child { border-bottom: none; }
  .label { color: #8e8e93; font-size: 15px; }
  .val { font-family: monospace; font-size: 15px; font-weight: 500; }
  .btn { display: block; width: 100%; padding: 16px; background: #007AFF; color: white;
         text-decoration: none; border-radius: 12px; text-align: center;
         font-size: 17px; font-weight: 600; margin-bottom: 16px; }
  .steps { list-style: none; counter-reset: s; }
  .steps li { counter-increment: s; padding: 8px 0 8px 36px; position: relative;
               border-bottom: 1px solid #f2f2f7; font-size: 15px; }
  .steps li:last-child { border-bottom: none; }
  .steps li::before { content: counter(s); position: absolute; left: 0; top: 8px;
                       background: #007AFF; color: white; width: 24px; height: 24px;
                       border-radius: 12px; display: flex; align-items: center;
                       justify-content: center; font-size: 13px; font-weight: 700; }
  .note { font-size: 13px; color: #8e8e93; margin-top: 8px; }
  code { font-family: monospace; background: #f2f2f7; padding: 2px 6px; border-radius: 4px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>prox</h1>
  <div class="card">
    <h2>Параметры</h2>
    <div class="row"><span class="label">Прокси</span><span class="val">${SERVER_HOST}</span></div>
    <div class="row"><span class="label">Логин</span><span class="val">${PROXY_USER}</span></div>
    <div class="row"><span class="label">Пароль</span><span class="val">${PROXY_PASS}</span></div>
  </div>
  <a href="${baseUrl}/profile.mobileconfig" class="btn">Скачать iOS профиль (.mobileconfig)</a>
  <div class="card">
    <h2>Установка на iPhone</h2>
    <ol class="steps">
      <li>Открой эту страницу на iPhone в Safari</li>
      <li>Нажми «Скачать iOS профиль» — Safari предложит установить профиль</li>
      <li>Настройки → Общие → VPN и управление устройством</li>
      <li>Найди профиль «prox» → Установить</li>
      <li>Весь трафик идёт через прокси</li>
    </ol>
    <p class="note">Без App Store. Без аккаунта разработчика.</p>
  </div>
</div>
</body>
</html>`;
}
