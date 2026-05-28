'use strict';
const http = require('http');
const { exec } = require('child_process');
const WebSocket = require('ws');

const PROXY_PORT = 10809;
const WS_ENDPOINT = 'wss://prox.nikidav9.workers.dev/tunnel';
const TOKEN = 'f03e5c9e-16ae-484e-a405-c78695b1142a';
const REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

// Notify all running apps (Chrome/Edge) to reload proxy settings immediately
const PS_REFRESH = `powershell -NoProfile -NonInteractive -Command `
  + `"$t=Add-Type -MemberDefinition '[DllImport(\\"wininet.dll\\")]`
  + `public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);'`
  + ` -Name W -Namespace W -PassThru;$t::InternetSetOption(0,39,0,0);$t::InternetSetOption(0,37,0,0)"`;

function setProxy(enable, cb) {
  if (enable) {
    exec(`reg add "${REG}" /v ProxyEnable /t REG_DWORD /d 1 /f`);
    exec(`reg add "${REG}" /v ProxyServer /t REG_SZ /d "127.0.0.1:${PROXY_PORT}" /f`);
    exec(`reg add "${REG}" /v ProxyOverride /t REG_SZ /d "<local>" /f`, () => {
      exec(PS_REFRESH, cb);
    });
  } else {
    exec(`reg add "${REG}" /v ProxyEnable /t REG_DWORD /d 0 /f`, () => {
      exec(PS_REFRESH, cb);
    });
  }
}

const server = http.createServer((_req, res) => {
  res.writeHead(200); res.end('prox');
});

server.on('connect', (req, socket, head) => {
  const colonIdx = req.url.lastIndexOf(':');
  const host = req.url.slice(0, colonIdx);
  const port = parseInt(req.url.slice(colonIdx + 1) || '443', 10);

  const ws = new WebSocket(`${WS_ENDPOINT}?token=${TOKEN}`);
  let ready = false;

  ws.on('open', () => ws.send(JSON.stringify({ host, port })));

  ws.on('message', (data) => {
    if (!ready) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.ok) {
          ready = true;
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length) ws.send(head);
          socket.on('data', (chunk) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
          });
        } else {
          socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
          socket.destroy();
          ws.close();
        }
      } catch (_) {
        socket.destroy();
        ws.close();
      }
      return;
    }
    try { socket.write(data); } catch (_) {}
  });

  ws.on('error', () => { try { socket.destroy(); } catch (_) {} });
  ws.on('close', () => { try { socket.destroy(); } catch (_) {} });
  socket.on('error', () => { try { ws.close(); } catch (_) {} });
  socket.on('end', () => { try { ws.close(); } catch (_) {} });
});

server.listen(PROXY_PORT, '127.0.0.1', () => {
  setProxy(true, () => {
    console.log('');
    console.log('  +------------------------------------+');
    console.log('  |   prox  -  CONNECTED               |');
    console.log('  |                                    |');
    console.log('  |   Server  : Cloudflare             |');
    console.log('  |   Proxy   : 127.0.0.1:' + PROXY_PORT + '          |');
    console.log('  |                                    |');
    console.log('  |   RESTART YOUR BROWSER NOW         |');
    console.log('  |                                    |');
    console.log('  |   Press Ctrl+C to disconnect       |');
    console.log('  +------------------------------------+');
    console.log('');
  });
});

process.on('SIGINT', () => {
  console.log('  Disconnecting...');
  setProxy(false, () => {
    console.log('  Done. Proxy disabled.');
    server.close(() => process.exit(0));
  });
});

process.on('uncaughtException', (e) => {
  console.error('  Error:', e.message);
  setProxy(false, () => process.exit(1));
});
