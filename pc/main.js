'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const { exec, execSync, spawn } = require('child_process');
const http = require('http');
const fs   = require('fs');
const net  = require('net');
const os   = require('os');
const path = require('path');

const PROXY_PORT   = 10809;
const VLESS_UUID   = 'f03e5c9e-16ae-484e-a405-c78695b1142a';
const VLESS_HOST   = 'prox.nikidav9.workers.dev';
const WS_ENDPOINT  = `wss://${VLESS_HOST}/tunnel`;
const XRAY_VER     = 'v26.3.27';
const XRAY_ZIP_URL = `https://github.com/XTLS/Xray-core/releases/download/${XRAY_VER}/Xray-windows-64.zip`;
const REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const PS_REFRESH = 'powershell -NoProfile -NonInteractive -Command '
  + '"$t=Add-Type -MemberDefinition '
  + "\'[DllImport(\\\"wininet.dll\\\")]"
  + 'public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);\''
  + ' -Name W -Namespace W -PassThru;'
  + '$t::InternetSetOption(0,39,0,0);$t::InternetSetOption(0,37,0,0)"';

let win = null, tray = null, xrayProcess = null, proxyServer = null, connected = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else { app.on('second-instance', () => { if (win) { win.show(); win.focus(); } }); }

// ── Find xray.exe ──────────────────────────────────────────────────────────────

function findXray() {
  const candidates = [
    path.join(process.resourcesPath || '', 'xray.exe'),
    path.join(__dirname, 'resources', 'xray.exe'),
    path.join(app.getPath('userData'), 'xray.exe'),
  ];
  return candidates.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
}

// ── Runtime download ───────────────────────────────────────────────────────────

function downloadXray(onProgress) {
  return new Promise((resolve, reject) => {
    const zipPath     = path.join(os.tmpdir(), 'prox-xray.zip');
    const extractPath = path.join(os.tmpdir(), 'prox-xray-extract');
    const dest        = path.join(app.getPath('userData'), 'xray.exe');
    try {
      onProgress('Загрузка Xray...');
      execSync(
        `powershell -NoProfile -Command "(New-Object System.Net.WebClient).DownloadFile('${XRAY_ZIP_URL}','${zipPath}')"`,
        { stdio: 'pipe', timeout: 120000 }
      );
      onProgress('Распаковка...');
      if (fs.existsSync(extractPath)) fs.rmSync(extractPath, { recursive: true, force: true });
      fs.mkdirSync(extractPath, { recursive: true });
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractPath}' -Force"`,
        { stdio: 'pipe', timeout: 60000 }
      );
      fs.copyFileSync(path.join(extractPath, 'xray.exe'), dest);
      try { fs.unlinkSync(zipPath); } catch (_) {}
      try { fs.rmSync(extractPath, { recursive: true, force: true }); } catch (_) {}
      resolve(dest);
    } catch (e) { reject(e); }
  });
}

// ── Xray VLESS config ─────────────────────────────────────────────────────────

function makeXrayConfig() {
  return {
    log: { loglevel: 'warning' },
    inbounds: [{
      port: PROXY_PORT, listen: '127.0.0.1', protocol: 'http',
    }],
    outbounds: [{
      protocol: 'vless',
      settings: {
        vnext: [{ address: VLESS_HOST, port: 443,
          users: [{ id: VLESS_UUID, encryption: 'none' }] }],
      },
      streamSettings: {
        network: 'ws', security: 'tls',
        wsSettings: { path: '/vless', headers: { Host: VLESS_HOST } },
        tlsSettings: { serverName: VLESS_HOST, allowInsecure: false },
      },
    }],
  };
}

// ── Start / stop Xray ─────────────────────────────────────────────────────────

function startXray(xrayPath) {
  return new Promise((resolve, reject) => {
    const cfgPath = path.join(os.tmpdir(), 'prox-xray-config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(makeXrayConfig(), null, 2), 'utf8');

    let stderrBuf = '';
    xrayProcess = spawn(xrayPath, ['run', '-c', cfgPath], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    xrayProcess.stderr.on('data', (d) => { stderrBuf += d.toString(); });
    xrayProcess.on('error', (e) => { xrayProcess = null; reject(new Error(e.message)); });
    xrayProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        const msg = stderrBuf.slice(0, 300) || `exit ${code}`;
        xrayProcess = null;
        reject(new Error(msg));
      }
    });

    const deadline = Date.now() + 6000;
    const poll = () => {
      if (!xrayProcess) return; // already exited with error
      const s = net.createConnection({ port: PROXY_PORT, host: '127.0.0.1' });
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        if (!xrayProcess) { reject(new Error(stderrBuf.slice(0, 300) || 'Xray exited')); return; }
        if (Date.now() < deadline) setTimeout(poll, 250);
        else reject(new Error('Timeout: ' + stderrBuf.slice(0, 200)));
      });
    };
    setTimeout(poll, 500);
  });
}

function stopXray() {
  if (xrayProcess) { try { xrayProcess.kill(); } catch (_) {} xrayProcess = null; }
}

// ── Fallback: built-in WS tunnel proxy (raw TCP — handles HTTP + HTTPS) ────────

function createProxyServer() {
  const WebSocket = require('ws');

  function openTunnel(socket, host, port, initial) {
    const pending = initial ? [...initial] : [];
    const bufData = (c) => pending.push(c);
    socket.on('data', bufData);

    const ws = new WebSocket(
      `${WS_ENDPOINT}?token=${VLESS_UUID}&host=${encodeURIComponent(host)}&port=${port}`
    );
    ws.on('open', () => {
      socket.removeListener('data', bufData);
      for (const c of pending) ws.send(c);
      pending.length = 0;
      socket.on('data', (c) => { if (ws.readyState === WebSocket.OPEN) ws.send(c); });
    });
    ws.on('message', (d) => { try { socket.write(d); } catch (_) {} });
    ws.on('error',   () => { try { socket.destroy(); } catch (_) {} });
    ws.on('close',   () => { try { socket.destroy(); } catch (_) {} });
    socket.on('error', () => { try { ws.close(); } catch (_) {} });
    socket.on('end',   () => { try { ws.close(); } catch (_) {} });
  }

  // Raw TCP server — handles both CONNECT (HTTPS) and GET/POST (HTTP)
  const server = net.createServer((socket) => {
    let headerBuf = Buffer.alloc(0);

    function onHeader(chunk) {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const end = headerBuf.indexOf('\r\n\r\n');
      if (end < 0) return;

      socket.removeListener('data', onHeader);
      const body = headerBuf.slice(end + 4);
      const firstLine = headerBuf.slice(0, headerBuf.indexOf('\r\n')).toString();
      const [method, url] = firstLine.split(' ');

      if (method === 'CONNECT') {
        // HTTPS tunnel
        const ci = url.lastIndexOf(':');
        const host = url.slice(0, ci);
        const port = parseInt(url.slice(ci + 1) || '443', 10);
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        openTunnel(socket, host, port, body.length ? [body] : []);

      } else if (url && url.startsWith('http://')) {
        // Plain HTTP proxy request — rebuild without proxy headers, tunnel to host:80
        try {
          const parsed = new URL(url);
          const host = parsed.hostname;
          const port = parseInt(parsed.port || '80', 10);
          const path = (parsed.pathname || '/') + (parsed.search || '');

          const lines = headerBuf.slice(0, end).toString().split('\r\n');
          let req = `${method} ${path} HTTP/1.1\r\n`;
          for (let i = 1; i < lines.length; i++) {
            if (!lines[i].toLowerCase().startsWith('proxy-')) req += lines[i] + '\r\n';
          }
          req += 'Connection: close\r\n\r\n';

          openTunnel(socket, host, port, [Buffer.from(req), ...(body.length ? [body] : [])]);
        } catch (_) { socket.end(); }

      } else {
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nprox');
      }
    }

    socket.on('error', () => {});
    socket.on('data', onHeader);
  });

  return server;
}

// ── Windows system proxy ──────────────────────────────────────────────────────

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

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('connect', async () => {
  if (connected) return { ok: true };
  const notify = (msg) => win && win.webContents.send('status-msg', msg);

  try {
    // 1. Try Xray (VLESS — same as iPhone)
    let xrayPath = findXray();
    let xrayOk = false;

    if (!xrayPath) {
      try {
        xrayPath = await downloadXray(notify);
      } catch (_) {}
    }

    if (xrayPath) {
      try {
        notify('Запуск Xray...');
        await startXray(xrayPath);
        xrayOk = true;
        notify('Xray запущен (VLESS)');
      } catch (e) {
        stopXray();
        notify('Xray заблокирован — добавьте xray.exe в исключения антивируса');
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // 2. Fallback: built-in WS proxy (HTTP + HTTPS)
    if (!xrayOk) {
      notify('Запуск резервного прокси...');
      if (!proxyServer) {
        proxyServer = createProxyServer();
        await new Promise((resolve, reject) => {
          proxyServer.listen(PROXY_PORT, '127.0.0.1', resolve);
          proxyServer.once('error', reject);
        });
      }
      notify('Резервный прокси запущен');
      await new Promise(r => setTimeout(r, 800));
    }

    await new Promise(r => setProxy(true, r));
    connected = true;
    updateTray();
    return { ok: true };
  } catch (e) {
    stopXray();
    if (proxyServer) { try { proxyServer.close(); } catch (_) {} proxyServer = null; }
    await new Promise(r => setProxy(false, r));
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('disconnect', async () => {
  await new Promise(r => setProxy(false, r));
  stopXray();
  if (proxyServer) { try { proxyServer.close(); } catch (_) {} proxyServer = null; }
  connected = false;
  updateTray();
  return { ok: true };
});

ipcMain.handle('status', () => ({ connected }));
ipcMain.handle('hide',   () => { if (win) win.hide(); });
ipcMain.handle('quit',   () => {
  setProxy(false, () => { stopXray(); app.quit(); });
});

// ── Tray ──────────────────────────────────────────────────────────────────────

function makeTrayIcon(on) {
  const c = on ? '#7b68ee' : '#aaaaaa';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
    <circle cx="8" cy="8" r="7" fill="${c}"/>
    <path d="M8 4 L8 8 L11 8" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/>
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
  try {
    tray = new Tray(makeTrayIcon(false));
    tray.setToolTip('prox');
    tray.on('click', () => { if (win) { win.isVisible() ? win.hide() : win.show(); } });
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть', click: () => win && win.show() },
      { type: 'separator' },
      { label: 'Выйти', click: () => { setProxy(false, () => { stopXray(); app.quit(); }); } },
    ]));
  } catch (_) {}
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 620,
    resizable: false,
    frame: false,
    backgroundColor: '#f2f2f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('close', (e) => { e.preventDefault(); win.hide(); });
}

app.whenReady().then(() => { createTray(); createWindow(); });
app.on('before-quit', () => {
  if (win) win.removeAllListeners('close');
  setProxy(false);
  stopXray();
});
