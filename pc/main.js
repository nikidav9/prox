'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('http');
const { exec } = require('child_process');
const path = require('path');

const PROXY_PORT = 10809;
const WS_ENDPOINT = 'wss://prox.nikidav9.workers.dev/tunnel';
const TUNNEL_TOKEN = 'f03e5c9e-16ae-484e-a405-c78695b1142a';

let win = null;
let proxyServer = null;
let connected = false;

// ── Proxy server ─────────────────────────────────────────────────────────────

function createProxyServer() {
  const WebSocket = require('ws');

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('prox');
  });

  server.on('connect', (req, socket, head) => {
    const colonIdx = req.url.lastIndexOf(':');
    const host = req.url.slice(0, colonIdx);
    const port = parseInt(req.url.slice(colonIdx + 1) || '443', 10);

    const ws = new WebSocket(`${WS_ENDPOINT}?token=${TUNNEL_TOKEN}`);

    let tunnelReady = false;

    ws.on('open', () => {
      ws.send(JSON.stringify({ host, port }));
    });

    ws.on('message', (data) => {
      if (!tunnelReady) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.ok) {
            tunnelReady = true;
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
          socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
          socket.destroy();
          ws.close();
        }
        return;
      }
      try { socket.write(data); } catch (_) {}
    });

    ws.on('error', () => {
      if (!tunnelReady) {
        try {
          socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
        } catch (_) {}
      }
      try { socket.destroy(); } catch (_) {}
    });

    ws.on('close', () => { try { socket.destroy(); } catch (_) {} });

    socket.on('error', () => { try { ws.close(); } catch (_) {} });
    socket.on('end', () => { try { ws.close(); } catch (_) {} });
  });

  return server;
}

// ── Windows proxy settings ────────────────────────────────────────────────────

const REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function setWindowsProxy(enable) {
  if (enable) {
    exec(`reg add "${REG}" /v ProxyEnable /t REG_DWORD /d 1 /f`);
    exec(`reg add "${REG}" /v ProxyServer /t REG_SZ /d "127.0.0.1:${PROXY_PORT}" /f`);
    exec(`reg add "${REG}" /v ProxyOverride /t REG_SZ /d "<local>" /f`);
  } else {
    exec(`reg add "${REG}" /v ProxyEnable /t REG_DWORD /d 0 /f`);
  }
}

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.handle('connect', async () => {
  if (connected) return { ok: true };
  try {
    if (!proxyServer) {
      proxyServer = createProxyServer();
      await new Promise((resolve, reject) => {
        proxyServer.listen(PROXY_PORT, '127.0.0.1', resolve);
        proxyServer.once('error', reject);
      });
    }
    setWindowsProxy(true);
    connected = true;
    return { ok: true };
  } catch (e) {
    if (proxyServer) { proxyServer.close(); proxyServer = null; }
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('disconnect', async () => {
  setWindowsProxy(false);
  if (proxyServer) {
    await new Promise(r => proxyServer.close(r));
    proxyServer = null;
  }
  connected = false;
  return { ok: true };
});

ipcMain.handle('status', () => ({ connected }));

ipcMain.handle('close', () => { app.quit(); });

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 360,
    height: 560,
    resizable: false,
    frame: false,
    backgroundColor: '#111111',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  setWindowsProxy(false);
  app.quit();
});
