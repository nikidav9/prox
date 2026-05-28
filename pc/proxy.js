'use strict';
const http = require('http');
const { exec } = require('child_process');
const WebSocket = require('ws');

const PROXY_PORT = 10809;
const WS_ENDPOINT = 'wss://prox.nikidav9.workers.dev/tunnel';
const TOKEN = 'f03e5c9e-16ae-484e-a405-c78695b1142a';
const REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const PS_REFRESH = 'powershell -NoProfile -NonInteractive -Command '
  + '"$t=Add-Type -MemberDefinition '
  + "\'[DllImport(\\\"wininet.dll\\\")]"
  + 'public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);\''
  + ' -Name W -Namespace W -PassThru;'
  + '$t::InternetSetOption(0,39,0,0);$t::InternetSetOption(0,37,0,0)"';

function setProxy(enable, cb) {
  if (enable) {
    exec(`reg add "${REG}" /v ProxyEnable /t REG_DWORD /d 1 /f`);
    exec(`reg add "${REG}" /v ProxyServer /t REG_SZ /d "127.0.0.1:${PROXY_PORT}" /f`);
    exec(`reg add "${REG}" /v ProxyOverride /t REG_SZ /d "<local>" /f`, () => {
      exec(PS_REFRESH, () => cb && cb());
    });
  } else {
    exec(`reg add "${REG}" /v ProxyEnable /t REG_DWORD /d 0 /f`, () => {
      exec(PS_REFRESH, () => cb && cb());
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

  // Reply 200 immediately so browser doesn't time out
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

  // Buffer client data until WebSocket is open
  const pending = [];
  if (head && head.length) pending.push(head);
  socket.on('data', (chunk) => pending.push(chunk));

  // Host+port in URL — Worker connects immediately, no JSON round-trip
  const ws = new WebSocket(
    `${WS_ENDPOINT}?token=${TOKEN}&host=${encodeURIComponent(host)}&port=${port}`
  );

  ws.on('open', () => {
    // Flush buffered data
    for (const c of pending) ws.send(c);
    pending.length = 0;
    // Live forwarding
    socket.removeAllListeners('data');
    socket.on('data', (chunk) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    });
  });

  ws.on('message', (data) => {
    try { socket.write(data); } catch (_) {}
  });

  ws.on('error', () => { try { socket.destroy(); } catch (_) {} });
  ws.on('close',  () => { try { socket.destroy(); } catch (_) {} });
  socket.on('error', () => { try { ws.close(); } catch (_) {} });
  socket.on('end',   () => { try { ws.close(); } catch (_) {} });
});

server.listen(PROXY_PORT, '127.0.0.1', () => {
  setProxy(true, () => {
    console.log('prox connected - close this window or press Ctrl+C to disconnect');
  });
});

process.on('SIGINT', () => {
  setProxy(false, () => { server.close(() => process.exit(0)); });
});

process.on('uncaughtException', (e) => {
  console.error('Error:', e.message);
  setProxy(false, () => process.exit(1));
});
