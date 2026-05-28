/**
 * Cloudflare Worker — HTTP/HTTPS forward proxy + iOS mobileconfig generator
 * Free tier, no credit card, no server needed.
 */
import { connect } from 'cloudflare:sockets';

const REALM = 'prox';

export default {
  async fetch(request, env) {
    const PROXY_USER = env.PROXY_USER || 'user';
    const PROXY_PASS = env.PROXY_PASS || 'changeme';
    const url = new URL(request.url);
    const host = request.headers.get('host') || url.host;

    // DNS-over-HTTPS — GET and POST, outside method guard (iOS uses POST)
    if (url.pathname === '/dns-query') {
      const dohTarget = new URL('https://dns.google/dns-query');
      url.searchParams.forEach((v, k) => dohTarget.searchParams.set(k, v));
      const upstream = await fetch(dohTarget.toString(), {
        method: request.method,
        headers: {
          'accept': request.headers.get('accept') || 'application/dns-message',
          ...(request.headers.get('content-type')
            ? { 'content-type': request.headers.get('content-type') } : {}),
        },
        body: request.body || undefined,
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'content-type': upstream.headers.get('content-type') || 'application/dns-message',
          'cache-control': 'max-age=300',
          'access-control-allow-origin': '*',
        },
      });
    }

    // ── Management routes (public, no auth) ──────────────────────────────────
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (url.pathname === '/pac') {
        return new Response(makePAC(host), {
          headers: { 'content-type': 'application/x-ns-proxy-autoconfig' },
        });
      }

      // DNS mobileconfig — installs WITHOUT supervision (unlike global proxy)
      if (url.pathname === '/dns.mobileconfig') {
        const body = makeDNSMobileconfig(host);
        const bytes = new TextEncoder().encode(body);
        return new Response(bytes.buffer, {
          headers: {
            'Content-Type': 'application/x-apple-aspen-config',
            'Content-Disposition': 'attachment; filename="dns-prox.mobileconfig"',
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
          },
        });
      }

      if (url.pathname === '/profile.mobileconfig') {
        const body = makeMobileconfig(host, PROXY_USER, PROXY_PASS);
        const bytes = new TextEncoder().encode(body);
        return new Response(bytes.buffer, {
          status: 200,
          headers: {
            'Content-Type': 'application/x-apple-aspen-config',
            'Content-Disposition': 'attachment; filename="prox.mobileconfig"',
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
          },
        });
      }
      if (url.pathname === '/' || url.pathname === '') {
        return new Response(makeUI(host, PROXY_USER, PROXY_PASS), {
          headers: { 'content-type': 'text/html;charset=utf-8' },
        });
      }
    }

    // ── Proxy auth ────────────────────────────────────────────────────────────
    if (!checkAuth(request.headers.get('proxy-authorization'), PROXY_USER, PROXY_PASS)) {
      return new Response('Proxy Authentication Required', {
        status: 407,
        headers: { 'proxy-authenticate': `Basic realm="${REALM}"` },
      });
    }

    // ── HTTPS CONNECT tunnel ──────────────────────────────────────────────────
    if (request.method === 'CONNECT') {
      const [targetHost, targetPort] = request.url.split(':');
      const port = parseInt(targetPort || '443', 10);

      try {
        const socket = connect({ hostname: targetHost, port });
        // Pipe request body → socket (client → target)
        if (request.body) request.body.pipeTo(socket.writable).catch(() => {});
        // Return socket readable as response body (target → client)
        return new Response(socket.readable, {
          status: 200,
          statusText: 'Connection Established',
          headers: { 'content-type': 'application/octet-stream' },
        });
      } catch (err) {
        return new Response('Tunnel failed: ' + err.message, { status: 502 });
      }
    }

    // ── Plain HTTP proxy ──────────────────────────────────────────────────────
    if (request.url.startsWith('http://') || request.url.startsWith('https://')) {
      const headers = new Headers(request.headers);
      headers.delete('proxy-authorization');
      headers.delete('proxy-connection');
      try {
        return await fetch(request.url, {
          method: request.method,
          headers,
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
          redirect: 'follow',
        });
      } catch (err) {
        return new Response('Upstream error: ' + err.message, { status: 502 });
      }
    }

    return new Response('Bad Request', { status: 400 });
  },
};

// ── Auth ──────────────────────────────────────────────────────────────────────

function checkAuth(header, user, pass) {
  if (!header) return false;
  const [type, creds] = (header || '').split(' ');
  if (type !== 'Basic') return false;
  const decoded = atob(creds || '');
  const colon = decoded.indexOf(':');
  if (colon === -1) return false;
  return decoded.slice(0, colon) === user && decoded.slice(colon + 1) === pass;
}

// ── Generators ────────────────────────────────────────────────────────────────

function makeDNSMobileconfig(host) {
  const uuid = () => crypto.randomUUID();
  const rootId = uuid(), payloadId = uuid();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadDisplayName</key><string>DNS через prox (обход блокировок)</string>
  <key>PayloadIdentifier</key><string>com.prox.dns.${rootId}</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${rootId}</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadDisplayName</key><string>DNS Settings</string>
      <key>PayloadIdentifier</key><string>com.prox.dns.settings.${payloadId}</string>
      <key>PayloadType</key><string>com.apple.dnsSettings.managed</string>
      <key>PayloadUUID</key><string>${payloadId}</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>DNSSettings</key>
      <dict>
        <key>DNSProtocol</key><string>HTTPS</string>
        <key>ServerURL</key><string>https://dns.google/dns-query</string>
        <key>ServerAddresses</key>
        <array>
          <string>8.8.8.8</string>
          <string>8.8.4.4</string>
        </array>
      </dict>
    </dict>
  </array>
</dict>
</plist>`;
}

function makePAC(host) {
  return `function FindProxyForURL(url, host) {
  if (isPlainHostName(host)) return "DIRECT";
  if (host === "127.0.0.1" || host === "localhost") return "DIRECT";
  if (isInNet(host, "10.0.0.0", "255.0.0.0")) return "DIRECT";
  if (isInNet(host, "172.16.0.0", "255.240.0.0")) return "DIRECT";
  if (isInNet(host, "192.168.0.0", "255.255.0.0")) return "DIRECT";
  return "HTTPS ${host}:443";
}
`;
}

function makeMobileconfig(host, user, pass) {
  const uuid = () => crypto.randomUUID();
  const rootId = uuid(), payloadId = uuid();
  const pacUrl = `https://${host}/pac`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadDisplayName</key><string>prox</string>
  <key>PayloadIdentifier</key><string>com.prox.cf.${rootId}</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${rootId}</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadDisplayName</key><string>Global HTTP Proxy</string>
      <key>PayloadIdentifier</key><string>com.prox.proxy.${payloadId}</string>
      <key>PayloadType</key><string>com.apple.proxy.http.global</string>
      <key>PayloadUUID</key><string>${payloadId}</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>ProxyType</key><string>Auto</string>
      <key>ProxyPACURL</key><string>${pacUrl}</string>
      <key>ProxyUsername</key><string>${user}</string>
      <key>ProxyPassword</key><string>${pass}</string>
      <key>ProxyCaptiveLoginAllowed</key><true/>
      <key>ProxyPACFallbackAllowed</key><true/>
    </dict>
  </array>
</dict>
</plist>`;
}

function makeUI(host, user, pass) {
  const base = `https://${host}`;
  return `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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
.l{color:#8e8e93;font-size:15px}.v{font-family:monospace;font-size:15px;font-weight:500}
.btn{display:block;width:100%;padding:16px;background:#34C759;color:white;text-decoration:none;
  border-radius:12px;text-align:center;font-size:17px;font-weight:600;margin-bottom:12px}
.btn2{display:block;width:100%;padding:14px;background:#007AFF;color:white;text-decoration:none;
  border-radius:12px;text-align:center;font-size:15px;font-weight:600;margin-bottom:16px}
.badge{display:inline-block;background:#34C759;color:white;font-size:11px;font-weight:700;
  padding:2px 8px;border-radius:8px;margin-left:8px;vertical-align:middle}
.badge2{display:inline-block;background:#8e8e93;color:white;font-size:11px;font-weight:700;
  padding:2px 8px;border-radius:8px;margin-left:8px;vertical-align:middle}
ol{list-style:none;counter-reset:s}
li{counter-increment:s;padding:8px 0 8px 36px;position:relative;border-bottom:1px solid #f2f2f7;font-size:15px}
li:last-child{border-bottom:none}
li::before{content:counter(s);position:absolute;left:0;top:8px;background:#34C759;color:white;
  width:24px;height:24px;border-radius:12px;display:flex;align-items:center;justify-content:center;
  font-size:13px;font-weight:700}
.n{font-size:13px;color:#8e8e93;margin-top:8px}
.sep{text-align:center;color:#8e8e93;font-size:13px;margin:4px 0 12px}
</style></head><body>
<div class="w">
<h1>prox</h1>
<p class="sub">Обход блокировок для iPhone</p>

<div class="c">
  <h2>Шаг 1 — Установи DNS профиль <span class="badge">РЕКОМЕНДУЕТСЯ</span></h2>
  <p style="font-size:14px;color:#3c3c43;margin-bottom:12px">Обходит DNS-блокировки. Работает на Wi-Fi <b>и</b> мобильной сети. Устанавливается без ограничений.</p>
  <a href="${base}/dns.mobileconfig" class="btn">⬇ Скачать DNS профиль</a>
  <ol>
    <li>Открой эту страницу на iPhone в <b>Safari</b></li>
    <li>Нажми «Скачать DNS профиль» — Safari предложит разрешить загрузку</li>
    <li>Настройки → Общие → VPN и управление устройством</li>
    <li>Профиль «DNS через prox» → Установить</li>
    <li>Готово — DNS идёт через зашифрованный канал</li>
  </ol>
  <p class="n">Без App Store. Без аккаунта разработчика. Без контролируемого устройства.</p>
</div>

<div class="c">
  <h2>Параметры прокси (Wi-Fi) <span class="badge2">ДОП</span></h2>
  <p style="font-size:13px;color:#8e8e93;margin-bottom:8px">Для ручной настройки Wi-Fi прокси или PAC URL</p>
  <div class="r"><span class="l">Сервер</span><span class="v">${host}</span></div>
  <div class="r"><span class="l">Порт</span><span class="v">443</span></div>
  <div class="r"><span class="l">PAC URL</span><span class="v" style="font-size:12px">${base}/pac</span></div>
  <div class="r"><span class="l">Логин</span><span class="v">${user}</span></div>
  <div class="r"><span class="l">Пароль</span><span class="v">${pass}</span></div>
</div>

<a href="${base}/profile.mobileconfig" class="btn2">Скачать прокси профиль (только Wi-Fi)</a>

</div></body></html>`;
}
