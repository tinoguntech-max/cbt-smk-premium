#!/bin/bash
# ============================================================
# DEPLOY SCRIPT - LMS CBT SMK
# Target: Ubuntu 24 Fresh Install, akses root
# Jalankan: bash deploy-fresh-ubuntu24.sh
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

# ============================================================
# KONFIGURASI - Sesuaikan jika perlu
# ============================================================
APP_DIR="/var/www/lms-cbt"
APP_NAME="lms-smkn1kras"
DB_NAME="cbt_smk"
DB_USER="cbt_user"
DB_PASS="CbtSmk@2026!"
APP_PORT=3000
SESSION_SECRET="$(openssl rand -hex 32)"
DOMAIN="pts.smknegeri1kras.sch.id"
SSL_EMAIL="admin@smknegeri1kras.sch.id"

# ============================================================
echo ""
echo "============================================================"
echo "  LMS CBT SMK - Deploy ke Ubuntu 24"
echo "============================================================"
echo ""

# Pastikan running sebagai root
if [ "$EUID" -ne 0 ]; then
    err "Script ini harus dijalankan sebagai root. Gunakan: sudo bash deploy-fresh-ubuntu24.sh"
fi

# ============================================================
info "STEP 1: Update sistem..."
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
ok "Node.js: $(node --version), npm: $(npm --version)"

# Install PM2 global
npm install -g pm2 --silent
ok "PM2: $(pm2 --version)"

# ============================================================
info "STEP 3: Install MySQL 8..."
# ============================================================
if ! command -v mysql &>/dev/null; then
    apt install -y mysql-server
    systemctl start mysql
    systemctl enable mysql
fi
ok "MySQL: $(mysql --version)"

# ============================================================
info "STEP 4: Setup database..."
# ============================================================
mysql -e "CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -e "CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';"
mysql -e "GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';"
mysql -e "FLUSH PRIVILEGES;"
ok "Database '$DB_NAME' dan user '$DB_USER' siap"

# ============================================================
info "STEP 5: Install Redis..."
# ============================================================
if ! command -v redis-server &>/dev/null; then
    apt install -y redis-server
    systemctl start redis-server
    systemctl enable redis-server
fi
ok "Redis: $(redis-server --version)"

# ============================================================
info "STEP 6: Copy aplikasi ke server..."
# ============================================================
mkdir -p "$APP_DIR"

# Copy semua file dari direktori saat ini (jika script dijalankan dari folder project)
# Atau clone dari git jika ada
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/src/server.js" ]; then
    info "Menyalin file dari: $SCRIPT_DIR"
    rsync -a --exclude='node_modules' --exclude='.git' --exclude='logs' \
        "$SCRIPT_DIR/" "$APP_DIR/"
    ok "File aplikasi disalin ke $APP_DIR"
else
    warn "File src/server.js tidak ditemukan di $SCRIPT_DIR"
    warn "Pastikan Anda upload file aplikasi ke VPS terlebih dahulu"
    warn "Lanjutkan setup environment saja..."
fi

cd "$APP_DIR"

# ============================================================
info "STEP 7: Install dependencies Node.js..."
# ============================================================
if [ -f "package.json" ]; then
    npm install --omit=dev
    ok "Dependencies terinstall"
else
    warn "package.json tidak ditemukan, skip npm install"
fi

# ============================================================
info "STEP 8: Buat file .env..."
# ============================================================
cat > "$APP_DIR/.env" <<EOF
NODE_ENV=production
PORT=$APP_PORT
SESSION_SECRET=$SESSION_SECRET

# Database
DB_HOST=localhost
DB_PORT=3306
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASS
DB_NAME=$DB_NAME

# Redis (aktif)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
EOF
ok ".env dibuat"

# ============================================================
info "STEP 9: Import schema database..."
# ============================================================
if [ -f "$APP_DIR/sql/schema.sql" ]; then
    mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" < "$APP_DIR/sql/schema.sql"
    ok "Schema utama diimport"
fi

# Import SQL tambahan secara berurutan
SQL_FILES=(
    "sql/add_full_name_column.sql"
    "sql/add_profile_photo.sql"
    "sql/add_notifications.sql"
    "sql/add_live_classes.sql"
    "sql/add_assignments.sql"
    "sql/add_assignment_classes_table.sql"
    "sql/add_exam_classes.sql"
    "sql/add_question_pdf.sql"
    "sql/add_device_tokens.sql"
    "sql/add_auto_complete_minutes.sql"
    "sql/add_chapter_to_question_bank.sql"
    "sql/create_question_bank.sql"
    "sql/create_notifications.sql"
    "add-exam-display-options.sql"
    "create-submission-backup-table.sql"
    "fix-submission-backup-index.sql"
)

for sql_file in "${SQL_FILES[@]}"; do
    if [ -f "$APP_DIR/$sql_file" ]; then
        mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" < "$APP_DIR/$sql_file" 2>/dev/null || true
        ok "  Imported: $sql_file"
    fi
done

# ============================================================
info "STEP 10: Buat folder uploads & logs..."
# ============================================================
mkdir -p "$APP_DIR/src/public/uploads/photos"
mkdir -p "$APP_DIR/src/public/uploads/materials"
mkdir -p "$APP_DIR/src/public/uploads/questions"
mkdir -p "$APP_DIR/src/public/uploads/assignments"
mkdir -p "$APP_DIR/logs"
chmod -R 755 "$APP_DIR/src/public/uploads"
ok "Folder uploads dan logs siap"

# ============================================================
info "STEP 11: Setup PM2..."
# ============================================================
# Stop jika sudah ada
pm2 delete "$APP_NAME" 2>/dev/null || true

# Start dengan ecosystem config jika ada, atau langsung
if [ -f "$APP_DIR/ecosystem.config.js" ]; then
    cd "$APP_DIR" && pm2 start ecosystem.config.js
else
    pm2 start "$APP_DIR/src/server.js" --name "$APP_NAME" \
        --max-memory-restart 1G \
        --log "$APP_DIR/logs/pm2-out.log" \
        --error "$APP_DIR/logs/pm2-error.log"
fi

pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash || true
ok "PM2 dikonfigurasi dan autostart aktif"

# ============================================================
info "STEP 12: Setup Nginx sebagai reverse proxy..."
# ============================================================
if ! command -v nginx &>/dev/null; then
    apt install -y nginx
fi

cat > /etc/nginx/sites-available/lms-cbt <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    client_max_body_size 100M;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    location / {
        proxy_pass http://localhost:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
EOF

ln -sf /etc/nginx/sites-available/lms-cbt /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx && systemctl enable nginx
ok "Nginx dikonfigurasi untuk $DOMAIN"

# ============================================================
info "STEP 12b: Install SSL dengan Let's Encrypt..."
# ============================================================
apt install -y certbot python3-certbot-nginx

# Cek apakah domain sudah pointing ke server ini
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
DOMAIN_IP=$(dig +short "$DOMAIN" 2>/dev/null | tail -1)

if [ "$DOMAIN_IP" = "$SERVER_IP" ]; then
    certbot --nginx -d "$DOMAIN" \
        --non-interactive \
        --agree-tos \
        --email "$SSL_EMAIL" \
        --redirect
    ok "SSL aktif untuk https://$DOMAIN"
    # Auto-renew sudah otomatis via systemd timer di Ubuntu 24
    ok "Auto-renew SSL sudah aktif"
else
    warn "Domain $DOMAIN belum pointing ke IP $SERVER_IP (saat ini: $DOMAIN_IP)"
    warn "SSL dilewati. Setelah DNS diupdate, jalankan:"
    warn "  certbot --nginx -d $DOMAIN --non-interactive --agree-tos --email $SSL_EMAIL --redirect"
fi

# ============================================================
info "STEP 13: Setup Firewall (UFW)..."
# ============================================================
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ok "Firewall aktif (22, 80, 443)"

# ============================================================
echo ""
echo "============================================================"
ok "DEPLOY SELESAI!"
echo "============================================================"
echo ""
echo "  Akses aplikasi: https://$DOMAIN"
echo "  (atau http://$DOMAIN jika SSL belum aktif)"
echo ""
echo "  Database:"
echo "    Name    : $DB_NAME"
echo "    User    : $DB_USER"
echo "    Password: $DB_PASS"
echo ""
echo "  File .env ada di: $APP_DIR/.env"
echo ""
echo "  Perintah berguna:"
echo "    pm2 status              - cek status app"
echo "    pm2 logs $APP_NAME      - lihat log"
echo "    pm2 restart $APP_NAME   - restart app"
echo "    systemctl status nginx  - cek nginx"
echo "    systemctl status mysql  - cek mysql"
echo "    systemctl status redis  - cek redis"
echo "    certbot renew --dry-run - test auto-renew SSL"
echo ""
warn "PENTING: Simpan password database di atas!"
warn "Ganti password root VPS setelah deploy selesai: passwd root"
warn "Pastikan DNS psaj.smkn1kras.sch.id sudah pointing ke IP VPS ini!"
echo "============================================================"
