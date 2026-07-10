'use strict';

const http = require('http');
const net = require('net');
const url = require('url');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
const EXTERNAL_PORT = process.env.EXTERNAL_PORT || PORT;
const XRAY_UUID = process.env.XRAY_UUID || '';
const XRAY_PORT = 8388;

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

const server = http.createServer((req, res) => {
  const reqUrl = url.parse(req.url);

  if (reqUrl.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('prox ok');
    return;
  }

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
  if (!target.hostname) { res.writeHead(400); res.end(); return; }

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

server.on('connect', (req, socket, head) => {
  if (!checkProxyAuth(req)) {
    socket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="prox"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
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
  if (XRAY_UUID) console.log(`[prox] VLESS UUID=${XRAY_UUID}`);
});

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
