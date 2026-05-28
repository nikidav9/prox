#!/bin/sh

# Derive stable UUID from PROXY_PASS so it survives container restarts
PROXY_PASS=${PROXY_PASS:-changeme}
XRAY_UUID=$(printf '%s-xray' "$PROXY_PASS" | sha256sum | cut -c1-32 | \
  sed 's/\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\)/\1-\2-\3-\4-\5/')
export XRAY_UUID

echo "[prox] VLESS UUID: $XRAY_UUID"

cat > /tmp/xray.json << EOF
{
  "log": {"loglevel": "warning"},
  "inbounds": [{
    "listen": "127.0.0.1",
    "port": 8388,
    "protocol": "vless",
    "settings": {
      "clients": [{"id": "${XRAY_UUID}", "level": 0}],
      "decryption": "none"
    },
    "streamSettings": {
      "network": "ws",
      "wsSettings": {"path": "/vless"}
    }
  }],
  "outbounds": [{"protocol": "freedom"}]
}
EOF

xray run -config /tmp/xray.json &

exec node src/server.js
