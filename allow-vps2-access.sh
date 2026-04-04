#!/bin/bash
# ============================================================
# Buka akses MySQL & Redis di VPS 1 untuk VPS 2
# Jalankan di VPS 1: bash allow-vps2-access.sh
# ============================================================

VPS2_IP="152.42.215.132"
DB_USER="cbt_user"
DB_PASS="CbtSmk@2026!"
DB_NAME="cbt_smk"

echo "[INFO] Membuka akses MySQL untuk VPS 2 ($VPS2_IP)..."
mysql -e "CREATE USER IF NOT EXISTS '$DB_USER'@'$VPS2_IP' IDENTIFIED BY '$DB_PASS';"
mysql -e "GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'$VPS2_IP';"
mysql -e "FLUSH PRIVILEGES;"
echo "[OK] MySQL: user $DB_USER@$VPS2_IP dibuat"

echo "[INFO] Update MySQL bind-address..."
sed -i 's/^bind-address\s*=.*/bind-address = 0.0.0.0/' /etc/mysql/mysql.conf.d/mysqld.cnf
systemctl restart mysql
echo "[OK] MySQL listen di 0.0.0.0"

echo "[INFO] Update Redis bind-address..."
sed -i 's/^bind 127.0.0.1/bind 0.0.0.0/' /etc/redis/redis.conf
systemctl restart redis-server
echo "[OK] Redis listen di 0.0.0.0"

echo "[INFO] Buka firewall untuk VPS 2..."
ufw allow from $VPS2_IP to any port 3306
ufw allow from $VPS2_IP to any port 6379
ufw reload
echo "[OK] Firewall: port 3306 & 6379 dibuka untuk $VPS2_IP"

echo ""
echo "============================================================"
echo "[OK] VPS 1 siap menerima koneksi dari VPS 2"
echo "============================================================"
