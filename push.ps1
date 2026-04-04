# ============================================================
# push.ps1 - Git push lokal + pull di VPS + restart PM2
# Jalankan: .\push.ps1
# Dengan pesan commit: .\push.ps1 -Message "update fitur"
# Dengan target VPS: .\push.ps1 -Target vps2
# Keduanya: .\push.ps1 -Message "fix bug" -Target vps2
# ============================================================

param(
    [string]$Message = "update",
    [string]$Target  = "vps1"
)

# Konfigurasi VPS
$VPS = @{
    vps1 = @{ IP = "178.128.88.30";  User = "root"; Dir = "/var/www/lms-cbt"; Name = "psaj.smkn1kras.sch.id" }
    vps2 = @{ IP = "178.128.217.57"; User = "root"; Dir = "/var/www/lms-cbt"; Name = "pts.smknegeri1kras.sch.id" }
}

if (-not $VPS.ContainsKey($Target)) {
    Write-Host "[ERROR] Target tidak dikenal: $Target. Gunakan: vps1 atau vps2" -ForegroundColor Red
    exit 1
}

$cfg  = $VPS[$Target]
$IP   = $cfg.IP
$USER = $cfg.User
$DIR  = $cfg.Dir
$NAME = $cfg.Name
$SSH  = "$USER@$IP"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Push ke $NAME ($IP)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# ============================================================
# 1. Git commit & push
# ============================================================
Write-Host "[GIT] Staging semua perubahan..." -ForegroundColor Blue
git add .

# Cek apakah ada yang perlu di-commit
$status = git status --porcelain
if ($status) {
    Write-Host "[GIT] Commit: $Message" -ForegroundColor Blue
    git commit -m $Message
} else {
    Write-Host "[GIT] Tidak ada perubahan baru, skip commit." -ForegroundColor Yellow
}

Write-Host "[GIT] Push ke GitHub..." -ForegroundColor Blue
git push
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Git push gagal. Cek koneksi atau remote URL." -ForegroundColor Red
    exit 1
}
Write-Host "[GIT] Push berhasil." -ForegroundColor Green

# ============================================================
# 2. VPS: git pull + npm install + restart PM2
# ============================================================
Write-Host ""
Write-Host "[VPS] Menjalankan git pull di $IP..." -ForegroundColor Blue

ssh -o StrictHostKeyChecking=no $SSH "cd $DIR && git pull"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[WARN] Git pull gagal, coba force reset..." -ForegroundColor Yellow
    ssh -o StrictHostKeyChecking=no $SSH "cd $DIR && git fetch origin && git reset --hard origin/main"
}

# Install jika ada package baru
ssh -o StrictHostKeyChecking=no $SSH "cd $DIR && npm install --omit=dev --prefer-offline --silent 2>&1 | tail -2"

# Restart PM2
ssh -o StrictHostKeyChecking=no $SSH "pm2 restart lms-smkn1kras --update-env && pm2 status"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  [OK] Deploy selesai -> https://$NAME" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
