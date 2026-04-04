#!/bin/bash
# ============================================================
# Setup Nginx + Redis untuk VPS 1
# Domain: psaj.smkn1kras.sch.id
# Catatan: Socket.io tidak pakai Redis adapter,
#          jadi PM2 pakai 1 instance (bukan cluster max)
# Jalankan di VPS: bash setup-nginx-redis-vps1.sh
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
info() { echo -e "${BLUE}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

APP_DIR="/var/www/lms-cbt"
APP_NAME="lms-smkn1kras"
APP_PORT=3000
DOMAIN="psaj.smkn1kras.sch.id"
SSL_EMAIL="admin@smkn1kras.sch.id"

echo ""
echo "============================================================"
echo "  Setup Nginx + Redis - VPS 1 ($DOMAIN)"
echo "============================================================"
echo ""

[ "$EUID" -ne 0 ] && err "Jalankan sebagai root"

# ============================================================
info "STEP 1: Konfigurasi Redis..."
# ============================================================

# Pastikan Redis terinstall
if ! command -v redis-server &>/dev/null; then
    apt install -y redis-server
fi

# Konfigurasi Redis untuk production
cat > /etc/redis/redis.conf <<'EOF'
# Network
bind 127.0.0.1
port 6379
protected-mode yes

# General
daemonize yes
supervised systemd
pidfile /var/run/redis/redis-server.pid
loglevel notice
logfile /var/log/redis/redis-server.log

# Memory management
maxmemory 256mb
maxmemory-policy allkeys-lru

# Persistence (RDB snapshot)
save 900 1
save 300 10
save 60 10000
dbfilename dump.rdb
dir /var/lib/redis

# Session TTL default
timeout 0
tcp-keepalive 300
EOF

systemctl restart redis-server
systemctl enable redis-server

# Test Redis
redis-cli ping | grep -q PONG && ok "Redis berjalan (PONG)" || err "Redis gagal"

# ============================================================
info "STEP 2: Update .env untuk aktifkan Redis..."
# ============================================================

if [ -f "$APP_DIR/.env" ]; then
    # Aktifkan Redis di .env
    sed -i 's/^# REDIS_HOST=localhost/REDIS_HOST=localhost/' "$APP_DIR/.env"
    sed -i 's/^# REDIS_PORT=6379/REDIS_PORT=6379/' "$APP_DIR/.env"
    sed -i 's/^# REDIS_PASSWORD=/REDIS_PASSWORD=/' "$APP_DIR/.env"

    # Jika baris REDIS_HOST belum ada sama sekali, tambahkan
    if ! grep -q "^REDIS_HOST=" "$APP_DIR/.env"; then
        echo "" >> "$APP_DIR/.env"
        echo "# Redis" >> "$APP_DIR/.env"
        echo "REDIS_HOST=localhost" >> "$APP_DIR/.env"
        echo "REDIS_PORT=6379" >> "$APP_DIR/.env"
        echo "REDIS_PASSWORD=" >> "$APP_DIR/.env"
    fi
    ok ".env diupdate dengan Redis config"
else
    warn ".env tidak ditemukan di $APP_DIR"
fi

# ============================================================
info "STEP 3: Update ecosystem.config.js (1 instance untuk Socket.io)..."
# ============================================================

# Socket.io tidak pakai Redis adapter, cluster mode akan
# menyebabkan socket events tidak sync antar instance.
# Gunakan fork mode dengan 1 instance.
cat > "$APP_DIR/ecosystem.config.js" <<'EOF'
module.exports = {
  apps: [{
    name: 'lms-smkn1kras',
    script: './src/server.js',
    instances: 'max',      // semua CPU cores, aman karena pakai Redis adapter
    exec_mode: 'cluster',  // cluster mode untuk load balancing
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    listen_timeout: 5000,
    kill_timeout: 5000,
    shutdown_with_message: true,
    wait_ready: true,
    cron_restart: '0 3 * * *',
    env_file: '.env'
  }]
};
EOF
ok "ecosystem.config.js diupdate (cluster mode, Redis adapter aktif)"

# ============================================================
info "STEP 4: Restart PM2 dengan config baru..."
# ============================================================
cd "$APP_DIR"
pm2 delete "$APP_NAME" 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
ok "PM2 direstart"

# Tunggu app ready
sleep 3
pm2 status

# ============================================================
info "STEP 5: Konfigurasi Nginx dengan optimasi..."
# ============================================================

apt install -y nginx

# Tulis rate limiting dan upstream ke nginx.conf (http context)
# agar tidak konflik dengan sites-available
cat > /etc/nginx/conf.d/lms-upstream.conf <<EOF
# Rate limiting
limit_req_zone \$binary_remote_addr zone=lms_login:10m rate=10r/m;
limit_req_zone \$binary_remote_addr zone=lms_api:10m rate=60r/m;

# Upstream Node.js app
upstream lms_app {
    server 127.0.0.1:$APP_PORT;
    keepalive 32;
}
EOF

cat > /etc/nginx/sites-available/lms-cbt <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    # SSL (akan diisi certbot)
    # ssl_certificate ...
    # ssl_certificate_key ...

    client_max_body_size 100M;
    client_body_timeout 60s;
    client_header_timeout 60s;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript
               text/xml application/xml image/svg+xml;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Static files langsung dari disk
    location /public/ {
        alias $APP_DIR/src/public/;
        expires 30d;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    # Rate limit login
    location /login {
        limit_req zone=lms_login burst=5 nodelay;
        proxy_pass http://lms_app;
        include /etc/nginx/proxy_params_lms;
    }

    # Socket.io - perlu header Upgrade
    location /socket.io/ {
        proxy_pass http://lms_app;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    # Main app
    location / {
        proxy_pass http://lms_app;
        include /etc/nginx/proxy_params_lms;
    }
}
EOF

# Buat file proxy params reusable
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

ln -sf /etc/nginx/sites-available/lms-cbt /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

nginx -t && ok "Nginx config valid"

# ============================================================
info "STEP 6: Install SSL dengan Certbot..."
# ============================================================
apt install -y certbot python3-certbot-nginx

SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
DOMAIN_IP=$(dig +short "$DOMAIN" 2>/dev/null | tail -1)

if [ "$DOMAIN_IP" = "$SERVER_IP" ]; then
    # Sementara pakai HTTP dulu untuk certbot challenge
    # Ubah nginx config ke HTTP only dulu
    cat > /etc/nginx/sites-available/lms-cbt-temp <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://lms_app;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
    }
}
EOF
    ln -sf /etc/nginx/sites-available/lms-cbt-temp /etc/nginx/sites-enabled/lms-cbt
    nginx -s reload

    certbot --nginx -d "$DOMAIN" \
        --non-interactive \
        --agree-tos \
        --email "$SSL_EMAIL" \
        --redirect

    # Restore config lengkap
    ln -sf /etc/nginx/sites-available/lms-cbt /etc/nginx/sites-enabled/lms-cbt
    rm -f /etc/nginx/sites-available/lms-cbt-temp
    nginx -t && systemctl reload nginx
    ok "SSL aktif: https://$DOMAIN"
else
    warn "DNS $DOMAIN belum pointing ke $SERVER_IP (resolve: $DOMAIN_IP)"
    warn "Jalankan ini setelah DNS aktif:"
    warn "  certbot --nginx -d $DOMAIN --non-interactive --agree-tos --email $SSL_EMAIL --redirect"
    # Jalankan nginx tanpa SSL dulu
    # Ganti config ke HTTP only sementara
    sed -i 's/return 301 https/# return 301 https/' /etc/nginx/sites-available/lms-cbt
    sed -i 's/listen 443 ssl http2/listen 80/' /etc/nginx/sites-available/lms-cbt
    sed -i 's/server_name psaj/server_name _ psaj/' /etc/nginx/sites-available/lms-cbt
    nginx -t && systemctl restart nginx
    ok "Nginx berjalan di HTTP (port 80)"
fi

systemctl enable nginx

# ============================================================
info "STEP 7: Setup Firewall..."
# ============================================================
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ok "Firewall aktif"

# ============================================================
echo ""
echo "============================================================"
ok "SETUP SELESAI!"
echo "============================================================"
echo ""
echo "  Akses: https://$DOMAIN"
echo ""
echo "  Status services:"
echo "    Redis  : $(systemctl is-active redis-server)"
echo "    Nginx  : $(systemctl is-active nginx)"
echo "    PM2    : $(pm2 jlist 2>/dev/null | python3 -c 'import sys,json; apps=json.load(sys.stdin); print(apps[0]["pm2_env"]["status"])' 2>/dev/null || echo 'cek: pm2 status')"
echo ""
echo "  Monitoring:"
echo "    pm2 monit                    - realtime monitor"
echo "    pm2 logs $APP_NAME           - lihat log app"
echo "    redis-cli monitor            - monitor redis commands"
echo "    tail -f /var/log/nginx/error.log - nginx error log"
echo "    certbot renew --dry-run      - test SSL renew"
echo "============================================================"
