#!/usr/bin/env bash
# Быстрая установка prox на чистый Ubuntu/Debian сервер
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[+]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[x]${NC} $*"; exit 1; }

[[ $EUID -eq 0 ]] || error "Запусти от root: sudo bash setup.sh"

# ── Определяем IP сервера ────────────────────────────────────────────────────
SERVER_IP=$(curl -4 -fsSL ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
info "IP сервера: $SERVER_IP"

# ── Docker ───────────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  info "Устанавливаю Docker..."
  curl -fsSL https://get.docker.com | sh
fi

if ! command -v docker-compose &>/dev/null && ! docker compose version &>/dev/null 2>&1; then
  info "Устанавливаю docker-compose plugin..."
  apt-get install -y docker-compose-plugin 2>/dev/null || \
    curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" \
      -o /usr/local/bin/docker-compose && chmod +x /usr/local/bin/docker-compose
fi

# ── Создаём .env ─────────────────────────────────────────────────────────────
INSTALL_DIR="${INSTALL_DIR:-/opt/prox}"
mkdir -p "$INSTALL_DIR"

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  PASS=$(openssl rand -hex 12)
  cat > "$INSTALL_DIR/.env" <<EOF
SERVER_HOST=$SERVER_IP
PORT=8080
MGMT_PORT=8081
PROXY_USER=user
PROXY_PASS=$PASS
EOF
  info "Создан .env с паролем: $PASS"
fi

# ── Копируем файлы ────────────────────────────────────────────────────────────
cp -r "$(dirname "$0")"/* "$INSTALL_DIR/" 2>/dev/null || true

# ── Firewall ──────────────────────────────────────────────────────────────────
if command -v ufw &>/dev/null; then
  ufw allow 8080/tcp comment "prox proxy" || true
  ufw allow 8081/tcp comment "prox mgmt" || true
  info "Открыты порты 8080 и 8081 в ufw"
fi

# ── Запуск ────────────────────────────────────────────────────────────────────
cd "$INSTALL_DIR"
docker compose up -d --build 2>/dev/null || docker-compose up -d --build

# ── Итог ─────────────────────────────────────────────────────────────────────
source "$INSTALL_DIR/.env"
echo ""
echo -e "${GREEN}══════════════════════════════════════════${NC}"
echo -e "${GREEN}  prox запущен!${NC}"
echo -e "${GREEN}══════════════════════════════════════════${NC}"
echo ""
echo -e "  Управление:   http://${SERVER_IP}:${MGMT_PORT}/"
echo -e "  iOS профиль:  http://${SERVER_IP}:${MGMT_PORT}/profile.mobileconfig"
echo ""
echo -e "  Прокси:  ${SERVER_IP}:${PORT}"
echo -e "  Логин:   ${PROXY_USER}"
echo -e "  Пароль:  ${PROXY_PASS}"
echo ""
echo -e "  Открой страницу управления на iPhone в Safari"
echo -e "  и нажми «Скачать iOS профиль»"
echo ""
