'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const http = require('http');
const { exec } = require('child_process');
const path = require('path');

const PROXY_PORT = 10809;
const WS_ENDPOINT = 'wss://prox.nikidav9.workers.dev/tunnel';
const TUNNEL_TOKEN = 'f03e5c9e-16ae-484e-a405-c78695b1142a';
const REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const PS_REFRESH = [
  'powershell -NoProfile -NonInteractive -Command',
  '"$t=Add-Type -MemberDefinition',
  `'[DllImport(\\"wininet.dll\\")]public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);'`,
  '-Name W -Namespace W -PassThru;',
  '$t::InternetSetOption(0,39,0,0);',
  '$t::InternetSetOption(0,37,0,0)"',
].join(' ');

let win = null;
let tray = null;
let proxyServer = null;
let connected = false;

// ── Single instance ──────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });
}

// ── Proxy ────────────────────────────────────────────────────────────────────

function createProxyServer() {
  const WebSocket = require('ws');
  const server = http.createServer((_req, res) => {
    res.writeHead(200); res.end('prox');
  });

  server.on('connect', (req, socket, head) => {
    const colonIdx = req.url.lastIndexOf(':');
    const host = req.url.slice(0, colonIdx);
    const port = parseInt(req.url.slice(colonIdx + 1) || '443', 10);

    const ws = new WebSocket(`${WS_ENDPOINT}?token=${TUNNEL_TOKEN}`);
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
            socket.destroy(); ws.close();
          }
        } catch (_) { socket.destroy(); ws.close(); }
        return;
      }
      try { socket.write(data); } catch (_) {}
    });

    ws.on('error', () => { try { socket.destroy(); } catch (_) {} });
    ws.on('close',  () => { try { socket.destroy(); } catch (_) {} });
    socket.on('error', () => { try { ws.close(); } catch (_) {} });
    socket.on('end',   () => { try { ws.close(); } catch (_) {} });
  });

  return server;
}

// ── Windows proxy settings ────────────────────────────────────────────────────

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
    await new Promise(r => setProxy(true, r));
    connected = true;
    updateTray();
    return { ok: true };
  } catch (e) {
    if (proxyServer) { proxyServer.close(); proxyServer = null; }
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('disconnect', async () => {
  await new Promise(r => setProxy(false, r));
  if (proxyServer) {
    await new Promise(r => proxyServer.close(r));
    proxyServer = null;
  }
  connected = false;
  updateTray();
  return { ok: true };
});

ipcMain.handle('status', () => ({ connected }));

ipcMain.handle('quit', () => {
  setProxy(false, () => app.quit());
});

ipcMain.handle('hide', () => {
  if (win) win.hide();
});

// ── Tray ─────────────────────────────────────────────────────────────────────

function makeTrayIcon(on) {
  // Simple 16x16 colored dot icon as data URL
  const color = on ? '#30d158' : '#636366';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
    <circle cx="8" cy="8" r="7" fill="${color}"/>
  </svg>`;
  return nativeImage.createFromDataURL(
    'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
  );
}

function updateTray() {
  if (!tray) return;
  tray.setImage(makeTrayIcon(connected));
  tray.setToolTip(connected ? 'prox — подключено' : 'prox — отключено');
}

function createTray() {
  tray = new Tray(makeTrayIcon(false));
  tray.setToolTip('prox — отключено');
  tray.on('click', () => {
    if (win) { win.isVisible() ? win.hide() : win.show(); }
  });
  const menu = Menu.buildFromTemplate([
    { label: 'Открыть', click: () => win && win.show() },
    { type: 'separator' },
    { label: 'Выйти', click: () => {
      setProxy(false, () => app.quit());
    }},
  ]);
  tray.setContextMenu(menu);
}

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

  win.loadFile(path.join(__dirname, 'index.html'));

  win.on('close', (e) => {
    e.preventDefault();
    win.hide();
  });
}

app.whenReady().then(() => {
  createTray();
  createWindow();
});

app.on('before-quit', () => {
  if (win) win.removeAllListeners('close');
  setProxy(false);
});
