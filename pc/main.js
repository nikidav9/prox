'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const { exec, spawn } = require('child_process');
const net  = require('net');
const tls  = require('tls');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const PROXY_PORT = 10809;
const VLESS_UUID = 'f03e5c9e-16ae-484e-a405-c78695b1142a';
const UUID_BYTES = Buffer.from(VLESS_UUID.replace(/-/g, ''), 'hex');

const SERVERS = {
  cf: {
    key:   'cf',
    label: 'Cloudflare',
    host:  'prox.nikidav9.workers.dev',
    wsUrl: 'wss://prox.nikidav9.workers.dev/vless',
  },
  railway: {
    key:   'railway',
    label: 'Railway',
    host:  'prox-production-e4e0.up.railway.app',
    wsUrl: 'wss://prox-production-e4e0.up.railway.app/vless',
  },
};

const REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

// ── State ─────────────────────────────────────────────────────────────────────

let win          = null;
let tray         = null;
let xrayProc     = null;
let proxyServer  = null;
let connected    = false;
let activeServer = null;   // current SERVERS entry
let preferred    = 'railway'; // user preference

// ── Helpers ───────────────────────────────────────────────────────────────────

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const notify = (msg) => { try { win?.webContents.send('status-msg', msg); } catch (_) {} };

// ── VLESS header ──────────────────────────────────────────────────────────────

function buildVlessHeader(host, port) {
  const isIPv4   = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const addrType = isIPv4 ? 0x01 : 0x02;
  const addrBuf  = isIPv4
    ? Buffer.from(host.split('.').map(Number))
    : Buffer.concat([Buffer.from([host.length]), Buffer.from(host, 'utf8')]);
  const portBuf  = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  return Buffer.concat([
    Buffer.from([0x00]),      // version
    UUID_BYTES,               // UUID (16 bytes)
    Buffer.from([0x00]),      // addLen = 0
    Buffer.from([0x01]),      // cmd = TCP
    portBuf,                  // destination port
    Buffer.from([addrType]),  // address type
    addrBuf,                  // address
  ]);
}

// ── WebSocket tunnel ──────────────────────────────────────────────────────────

function openTunnel(socket, host, port, initialChunks) {
  if (!activeServer) { try { socket.destroy(); } catch (_) {} return; }

  const WebSocket = require('ws');
  const pending   = initialChunks ? [...initialChunks] : [];
  const bufData   = (c) => pending.push(c);
  socket.on('data', bufData);
  socket.on('error', () => {});

  const ws = new WebSocket(activeServer.wsUrl);
  let stripped = false;

  ws.on('open', () => {
    socket.removeListener('data', bufData);
    const hdr   = buildVlessHeader(host, port);
    const frame = pending.length ? Buffer.concat([hdr, ...pending]) : hdr;
    ws.send(frame);
    pending.length = 0;
    socket.on('data', (c) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(c);
    });
  });

  ws.on('message', (d) => {
    const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
    if (!stripped) {
      stripped = true;
      const skip = 2 + (buf[1] || 0); // ver(1) + addLen(1) + addData(addLen)
      if (buf.length > skip) try { socket.write(buf.slice(skip)); } catch (_) {}
      return;
    }
    try { socket.write(buf); } catch (_) {}
  });

  ws.on('error', () => { try { socket.destroy(); } catch (_) {} });
  ws.on('close', () => { try { socket.destroy(); } catch (_) {} });
  socket.on('close', () => { try { ws.close();   } catch (_) {} });
  socket.on('end',   () => { try { ws.close();   } catch (_) {} });
}

// ── TCP proxy server ──────────────────────────────────────────────────────────

function createProxyServer() {
  return net.createServer((socket) => {
    socket.on('error', () => {});
    let headerBuf = Buffer.alloc(0);

    function onHeader(chunk) {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const end = headerBuf.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.removeListener('data', onHeader);

      const body      = headerBuf.slice(end + 4);
      const firstLine = headerBuf.slice(0, headerBuf.indexOf('\r\n')).toString();
      const parts     = firstLine.split(' ');
      const method    = parts[0];
      const url       = parts[1] || '';

      if (method === 'CONNECT') {
        const ci   = url.lastIndexOf(':');
        const host = ci > 0 ? url.slice(0, ci) : url;
        const port = ci > 0 ? parseInt(url.slice(ci + 1) || '443', 10) : 443;
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        openTunnel(socket, host, port, body.length ? [body] : []);
        return;
      }

      if (url.startsWith('http://')) {
        try {
          const parsed  = new URL(url);
          const host    = parsed.hostname;
          const port    = parseInt(parsed.port || '80', 10);
          const reqPath = (parsed.pathname || '/') + (parsed.search || '');
          const lines   = headerBuf.slice(0, end).toString().split('\r\n');
          let rebuilt   = `${method} ${reqPath} HTTP/1.1\r\n`;
          for (let i = 1; i < lines.length; i++) {
            const lower = lines[i].toLowerCase();
            if (!lower.startsWith('proxy-') && !lower.startsWith('connection:'))
              rebuilt += lines[i] + '\r\n';
          }
          rebuilt += 'Connection: close\r\n\r\n';
          openTunnel(socket, host, port,
            [Buffer.from(rebuilt), ...(body.length ? [body] : [])]);
        } catch (_) { socket.end(); }
        return;
      }

      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nprox');
    }

    socket.on('data', onHeader);
  });
}

// ── Proxy lifecycle ───────────────────────────────────────────────────────────

function startWSProxy() {
  return new Promise((resolve, reject) => {
    if (proxyServer) { resolve(); return; }
    proxyServer = createProxyServer();
    proxyServer.listen(PROXY_PORT, '127.0.0.1', resolve);
    proxyServer.once('error', (e) => { proxyServer = null; reject(e); });
  });
}

function stopWSProxy() {
  if (!proxyServer) return;
  try { proxyServer.close(); } catch (_) {}
  proxyServer = null;
}

// ── Xray ──────────────────────────────────────────────────────────────────────

function findXray() {
  const candidates = [
    path.join(process.resourcesPath || '', 'xray.exe'),
    path.join(__dirname, 'resources', 'xray.exe'),
    path.join(app.getPath('userData'), 'xray.exe'),
  ];
  return candidates.find(p => { try { return fs.existsSync(p); } catch (_) {} }) || null;
}

function makeXrayConfig(server) {
  return {
    log: { loglevel: 'none' },
    inbounds: [{ listen: '127.0.0.1', port: PROXY_PORT, protocol: 'http' }],
    outbounds: [{
      protocol: 'vless',
      settings: {
        vnext: [{ address: server.host, port: 443,
          users: [{ id: VLESS_UUID, encryption: 'none' }] }],
      },
      streamSettings: {
        network: 'ws', security: 'tls',
        wsSettings:  { path: '/vless', headers: { Host: server.host } },
        tlsSettings: { serverName: server.host, allowInsecure: false },
      },
    }],
  };
}

function startXray(xrayPath, server) {
  return new Promise((resolve, reject) => {
    const cfgPath = path.join(os.tmpdir(), 'prox-xray.json');
    fs.writeFileSync(cfgPath, JSON.stringify(makeXrayConfig(server)), 'utf8');

    let errBuf = '', done = false;
    xrayProc = spawn(xrayPath, ['run', '-c', cfgPath], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    xrayProc.stderr.on('data', (d) => { errBuf += d; });
    xrayProc.on('error', (e) => { xrayProc = null; if (!done) reject(e); });
    xrayProc.on('exit', (code) => {
      if (code !== 0 && !done) {
        xrayProc = null;
        reject(new Error(errBuf.slice(0, 300) || `Xray exit ${code}`));
      }
    });

    const deadline = Date.now() + 5000;
    const poll = () => {
      if (!xrayProc) return;
      const s = net.createConnection({ port: PROXY_PORT, host: '127.0.0.1' });
      s.on('connect', () => { s.destroy(); done = true; resolve(); });
      s.on('error', () => {
        if (!xrayProc) { reject(new Error(errBuf.slice(0, 200) || 'Xray exited')); return; }
        if (Date.now() < deadline) setTimeout(poll, 200);
        else reject(new Error('Xray timeout'));
      });
    };
    setTimeout(poll, 300);
  });
}

function stopXray() {
  if (!xrayProc) return;
  try { xrayProc.kill(); } catch (_) {}
  xrayProc = null;
}

function watchXray() {
  if (!xrayProc) return;
  xrayProc.once('exit', async () => {
    xrayProc = null;
    if (!connected) return;
    notify('Xray упал, переключаю на встроенный прокси...');
    try {
      await startWSProxy();
    } catch (_) {
      await new Promise(r => setProxy(false, r));
      connected = false; activeServer = null;
      updateTray();
      try { win?.webContents.send('auto-disconnect'); } catch (_) {}
    }
  });
}

// ── Tunnel test (TLS-through-CONNECT) ────────────────────────────────────────
// Tests the actual HTTPS code path browsers use: HTTP CONNECT + TLS handshake.
// If TLS succeeds end-to-end, the VLESS tunnel is definitely working.

function testTunnel() {
  return new Promise((resolve) => {
    const sock = net.createConnection(PROXY_PORT, '127.0.0.1');
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) {}
      resolve(v);
    };

    sock.setTimeout(12000, () => done(false));
    sock.on('error', () => done(false));

    sock.once('connect', () => {
      sock.write('CONNECT cp.cloudflare.com:443 HTTP/1.1\r\nHost: cp.cloudflare.com:443\r\n\r\n');

      let connectBuf = Buffer.alloc(0);
      function onConnectResponse(chunk) {
        connectBuf = Buffer.concat([connectBuf, chunk]);
        if (!connectBuf.includes('\r\n\r\n')) return;

        // Remove this listener BEFORE setting up TLS to avoid data conflicts
        sock.removeListener('data', onConnectResponse);

        const firstLine = connectBuf.slice(0, connectBuf.indexOf('\r\n')).toString();
        if (!firstLine.includes('200')) { done(false); return; }

        // Tunnel open — do TLS handshake through it
        const tlsSock = tls.connect({
          socket: sock,
          servername: 'cp.cloudflare.com',
          rejectUnauthorized: true,
        });
        tlsSock.setTimeout(8000, () => { try { tlsSock.destroy(); } catch (_) {} done(false); });
        tlsSock.on('error', () => done(false));
        tlsSock.on('secureConnect', () => {
          try { tlsSock.destroy(); } catch (_) {}
          done(true);
        });
      }
      sock.on('data', onConnectResponse);
    });
  });
}

// ── Try one server (Xray first, then built-in proxy) ─────────────────────────

async function tryConnect(server) {
  activeServer = server;

  // 1. Xray
  const xrayPath = findXray();
  if (xrayPath) {
    try {
      notify(`${server.label}: запуск Xray...`);
      await startXray(xrayPath, server);
      notify(`${server.label}: проверка туннеля...`);
      if (await testTunnel()) {
        watchXray();
        return true;
      }
      notify(`${server.label}: Xray не прошёл тест`);
    } catch (e) {
      notify(`${server.label}: Xray ошибка — ${e.message.slice(0, 60)}`);
    }
    stopXray();
    await delay(400);
  }

  // 2. Built-in WS proxy
  try {
    notify(`${server.label}: встроенный прокси...`);
    await startWSProxy();
    notify(`${server.label}: проверка туннеля...`);
    if (await testTunnel()) return true;
    notify(`${server.label}: туннель не отвечает`);
  } catch (e) {
    notify(`${server.label}: ошибка — ${e.message.slice(0, 60)}`);
  }
  stopWSProxy();
  activeServer = null;
  await delay(400);
  return false;
}

// ── Windows system proxy ──────────────────────────────────────────────────────

function refreshIESettings(cb) {
  const psPath = path.join(os.tmpdir(), 'prox-wininet.ps1');
  // Write PS1 to a file to avoid all shell quoting issues
  const psContent =
    'Add-Type -MemberDefinition \'[DllImport("wininet.dll")]public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);\' -Name W -Namespace W\n' +
    '[W]::InternetSetOption(0,39,0,0)\n' +
    '[W]::InternetSetOption(0,37,0,0)\n';
  try { fs.writeFileSync(psPath, psContent, 'utf8'); } catch (_) { cb?.(); return; }
  exec(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${psPath}"`, () => cb?.());
}

function setProxy(enable, cb) {
  if (enable) {
    exec(`reg add "${REG}" /v ProxyEnable /t REG_DWORD /d 1 /f`, () =>
      exec(`reg add "${REG}" /v ProxyServer /t REG_SZ /d "127.0.0.1:${PROXY_PORT}" /f`, () =>
        exec(`reg add "${REG}" /v ProxyOverride /t REG_SZ /d "<local>" /f`, () =>
          refreshIESettings(cb))));
  } else {
    exec(`reg add "${REG}" /v ProxyEnable /t REG_DWORD /d 0 /f`, () =>
      refreshIESettings(cb));
  }
}

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.handle('get-servers', () => ({
  servers: Object.values(SERVERS).map(s => ({ key: s.key, label: s.label })),
  preferred,
  active: activeServer?.key || null,
}));

ipcMain.handle('set-server', (_, key) => {
  if (SERVERS[key]) preferred = key;
  return { ok: true };
});

ipcMain.handle('connect', async () => {
  if (connected) return { ok: true, server: activeServer?.label };
  await new Promise(r => setProxy(false, r));

  // Try preferred server first, then fallback
  const order = [SERVERS[preferred], ...Object.values(SERVERS).filter(s => s.key !== preferred)];

  for (const server of order) {
    const ok = await tryConnect(server);
    if (ok) {
      if (server.key !== preferred) {
        // Notify UI that we fell back
        try { win?.webContents.send('server-changed', server.key); } catch (_) {}
      }
      notify('Применяю настройки системы...');
      await new Promise(r => setProxy(true, r));
      connected = true;
      updateTray();
      return { ok: true, server: activeServer.label, key: activeServer.key };
    }
  }

  stopXray(); stopWSProxy();
  await new Promise(r => setProxy(false, r));
  return { ok: false, error: 'Нет подключения. Проверь интернет.' };
});

ipcMain.handle('disconnect', async () => {
  connected = false;
  activeServer = null;
  await new Promise(r => setProxy(false, r));
  stopXray();
  stopWSProxy();
  updateTray();
  return { ok: true };
});

ipcMain.handle('status', () => ({
  connected,
  server:    activeServer?.label || null,
  serverKey: activeServer?.key   || null,
  preferred,
}));

ipcMain.handle('hide', () => win?.hide());
ipcMain.handle('quit', () => { setProxy(false, () => { stopXray(); app.quit(); }); });

// ── Tray ──────────────────────────────────────────────────────────────────────

function makeTrayIcon(on) {
  const fill = on ? '#7b68ee' : '#aaaaaa';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
    <circle cx="8" cy="8" r="7" fill="${fill}"/>
    <circle cx="8" cy="8" r="3" fill="white" opacity=".9"/>
  </svg>`;
  return nativeImage.createFromDataURL(
    'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
}

function updateTray() {
  if (!tray) return;
  tray.setImage(makeTrayIcon(connected));
  tray.setToolTip(connected
    ? `prox — подключено (${activeServer?.label || ''})`
    : 'prox — отключено');
}

function createTray() {
  try {
    tray = new Tray(makeTrayIcon(false));
    tray.setToolTip('prox');
    tray.on('click', () => win && (win.isVisible() ? win.hide() : win.show()));
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть', click: () => win?.show() },
      { type: 'separator' },
      { label: 'Выйти', click: () => { setProxy(false, () => { stopXray(); app.quit(); }); } },
    ]));
  } catch (_) {}
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 380, height: 620,
    resizable: false, frame: false,
    backgroundColor: '#f5f4f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('close', (e) => { e.preventDefault(); win.hide(); });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

  app.whenReady().then(() => {
    setProxy(false); // clear any stale proxy from a previous session
    createTray();
    createWindow();
  });

  app.on('before-quit', () => {
    if (win) win.removeAllListeners('close');
    setProxy(false);
    stopXray();
  });
}
