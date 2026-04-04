#!/bin/bash
# ============================================================
# Setup VPS 2 sebagai node tambahan
# VPS 2: 178.128.217.57 (pts.smknegeri1kras.sch.id)
# DB & Redis tetap di VPS 1: 178.128.88.30
# Jalankan di VPS 2: bash setup-vps2-node.sh
# ============================================================

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
info() { echo -e "${BLUE}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

VPS1_IP="178.128.88.30"
APP_DIR="/var/www/lms-cbt"
APP_NAME="lms-smkn1kras"
DOMAIN="pts.smknegeri1kras.sch.id"
SSL_EMAIL="admin@smknegeri1kras.sch.id"
APP_PORT=3000

[ "$EUID" -ne 0 ] && err "Jalankan sebagai root"

echo ""
echo "============================================================"
echo "  Setup VPS 2 Node - $DOMAIN"
echo "============================================================"
echo ""

# ============================================================
info "STEP 1: Update sistem & install dependencies..."
# ============================================================
apt update -y && apt upgrade -y
apt install -y curl wget git unzip ufw htop nano dnsutils
ok "Sistem diupdate"

# ============================================================
info "STEP 2: Install Node.js 20..."
# ============================================================
if ! command -v node &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
fi
npm install -g pm2 --silent
ok "Node.js: $(node --version) | PM2: $(pm2 --version)"

# ============================================================
info "STEP 3: Clone aplikasi dari GitHub..."
# ============================================================
mkdir -p "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
    cd "$APP_DIR" && git pull
    ok "Git pull selesai"
else
    git clone https://github.com/tinoguntech-max/cbt-smk-premium.git "$APP_DIR"
    ok "Git clone selesai"
fi

# ============================================================
info "STEP 4: Install dependencies Node.js..."
# ============================================================
cd "$APP_DIR"
npm install --omit=dev
ok "Dependencies terinstall"

# ============================================================
info "STEP 5: Buat .env (koneksi ke DB & Redis VPS 1)..."
# ============================================================
# Ambil SESSION_SECRET dari VPS 1 jika bisa, atau generate baru
SESSION_SECRET=$(openssl rand -hex 32)

cat > "$APP_DIR/.env" <<EOF
NODE_ENV=production
PORT=$APP_PORT
SESSION_SECRET=$SESSION_SECRET

# Database - pakai MySQL di VPS 1
DB_HOST=$VPS1_IP
DB_PORT=3306
DB_USER=cbt_user
DB_PASSWORD=CbtSmk@2026!
DB_NAME=cbt_smk

# Redis - pakai Redis di VPS 1
REDIS_HOST=$VPS1_IP
REDIS_PORT=6379
REDIS_PASSWORD=
EOF
ok ".env dibuat (DB & Redis → VPS 1)"

# ============================================================
info "STEP 6: Buat folder uploads & logs..."
# ============================================================
mkdir -p "$APP_DIR/src/public/uploads/photos"
mkdir -p "$APP_DIR/src/public/uploads/materials"
mkdir -p "$APP_DIR/src/public/uploads/questions"
mkdir -p "$APP_DIR/src/public/uploads/assignments"
mkdir -p "$APP_DIR/logs"
ok "Folder siap"

# ============================================================
info "STEP 7: Setup PM2..."
# ============================================================
pm2 delete "$APP_NAME" 2>/dev/null || true
cd "$APP_DIR" && pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash || true
ok "PM2 berjalan"

# ============================================================
info "STEP 8: Setup Nginx..."
# ============================================================
apt install -y nginx
systemctl stop apache2 2>/dev/null || true
systemctl disable apache2 2>/dev/null || true

cat > /etc/nginx/conf.d/lms-upstream.conf <<EOF
upstream lms_app {
    server 127.0.0.1:$APP_PORT;
    keepalive 32;
}
EOF

cat > /etc/nginx/proxy_params_lms <<'EOF'
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Connection "";
proxy_cache_bypass $http_upgrade;
proxy_connect_timeout 60s;
proxy_send_timeout 60s;
proxy_read_timeout 60s;
EOF

cat > /etc/nginx/sites-available/lms-cbt <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    client_max_body_size 100M;
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;

    location /public/ {
        alias $APP_DIR/src/public/;
        expires 30d;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    location /socket.io/ {
        proxy_pass http://lms_app;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 86400s;
    }

    location / {
        proxy_pass http://lms_app;
        include /etc/nginx/proxy_params_lms;
    }
}
EOF

ln -sf /etc/nginx/sites-available/lms-cbt /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx && systemctl enable nginx
ok "Nginx berjalan"

# ============================================================
info "STEP 9: Install SSL..."
# ============================================================
apt install -y certbot python3-certbot-nginx
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null)
DOMAIN_IP=$(dig +short "$DOMAIN" 2>/dev/null | tail -1)

if [ "$DOMAIN_IP" = "$SERVER_IP" ]; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$SSL_EMAIL" --redirect
    ok "SSL aktif: https://$DOMAIN"
else
    warn "DNS $DOMAIN belum pointing ke $SERVER_IP (resolve: $DOMAIN_IP)"
    warn "Jalankan setelah DNS aktif: certbot --nginx -d $DOMAIN --non-interactive --agree-tos --email $SSL_EMAIL --redirect"
fi

# ============================================================
info "STEP 10: Firewall..."
# ============================================================
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ok "Firewall aktif"

echo ""
echo "============================================================"
ok "VPS 2 SIAP!"
echo "============================================================"
echo ""
echo "  Akses: https://$DOMAIN"
echo "  DB   : MySQL di VPS 1 ($VPS1_IP)"
echo "  Redis: Redis di VPS 1 ($VPS1_IP)"
echo ""
echo "  LANGKAH SELANJUTNYA:"
echo "  Buka akses MySQL & Redis di VPS 1 untuk VPS 2"
echo "  Jalankan di VPS 1:"
echo "    bash /root/allow-vps2-access.sh"
echo "============================================================"
