# ============================================================
# Upload Aplikasi ke VPS - Windows PowerShell
# Jalankan: .\upload-to-vps.ps1
# ============================================================

$VPS_IP = "178.128.88.30"
$VPS_USER = "root"
$VPS_PASS = "tinocaem"
$REMOTE_DIR = "/var/www/lms-cbt"
$LOCAL_DIR = $PSScriptRoot

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Upload LMS CBT ke VPS $VPS_IP" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# Cek apakah scp tersedia
if (-not (Get-Command scp -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] scp tidak ditemukan. Install OpenSSH atau gunakan Git Bash." -ForegroundColor Red
    exit 1
}

# Folder yang akan diupload (exclude node_modules, .git, logs)
$EXCLUDE_DIRS = @("node_modules", ".git", "logs", ".vscode")

Write-Host "[INFO] Membuat folder di VPS..." -ForegroundColor Blue

# Buat folder di VPS dulu via SSH
$sshCmd = "ssh -o StrictHostKeyChecking=no ${VPS_USER}@${VPS_IP} 'mkdir -p $REMOTE_DIR'"
Invoke-Expression $sshCmd

Write-Host "[INFO] Mengupload file ke VPS..." -ForegroundColor Blue
Write-Host "       Dari : $LOCAL_DIR" -ForegroundColor Gray
Write-Host "       Ke   : ${VPS_USER}@${VPS_IP}:$REMOTE_DIR" -ForegroundColor Gray
Write-Host ""

# Upload menggunakan rsync jika tersedia (lebih cepat), atau scp
if (Get-Command rsync -ErrorAction SilentlyContinue) {
    $excludeArgs = $EXCLUDE_DIRS | ForEach-Object { "--exclude=$_" }
    $rsyncCmd = "rsync -avz --progress $excludeArgs `"$LOCAL_DIR/`" `"${VPS_USER}@${VPS_IP}:$REMOTE_DIR/`""
    Write-Host "[INFO] Menggunakan rsync..." -ForegroundColor Blue
    Invoke-Expression $rsyncCmd
} else {
    Write-Host "[INFO] Menggunakan scp..." -ForegroundColor Blue
    Write-Host "[WARN] scp akan mengupload semua file termasuk node_modules (lambat)." -ForegroundColor Yellow
    Write-Host "       Disarankan gunakan Git untuk transfer file." -ForegroundColor Yellow
    
    # Upload folder src, sql, scripts, templates
    $foldersToUpload = @("src", "sql", "scripts", "templates")
    foreach ($folder in $foldersToUpload) {
        if (Test-Path "$LOCAL_DIR\$folder") {
            Write-Host "  Uploading $folder..." -ForegroundColor Gray
            scp -o StrictHostKeyChecking=no -r "$LOCAL_DIR\$folder" "${VPS_USER}@${VPS_IP}:$REMOTE_DIR/"
        }
    }
    
    # Upload file-file penting
    $filesToUpload = @(
        "package.json",
        "package-lock.json",
        "ecosystem.config.js",
        ".env.example",
        "deploy-fresh-ubuntu24.sh",
        "add-exam-display-options.sql",
        "create-submission-backup-table.sql",
        "fix-submission-backup-index.sql"
    )
    foreach ($file in $filesToUpload) {
        if (Test-Path "$LOCAL_DIR\$file") {
            Write-Host "  Uploading $file..." -ForegroundColor Gray
            scp -o StrictHostKeyChecking=no "$LOCAL_DIR\$file" "${VPS_USER}@${VPS_IP}:$REMOTE_DIR/"
        }
    }
}

Write-Host ""
Write-Host "[OK] Upload selesai!" -ForegroundColor Green
Write-Host ""
Write-Host "Sekarang jalankan deploy di VPS:" -ForegroundColor Yellow
Write-Host ""
Write-Host "  1. SSH ke VPS:" -ForegroundColor White
Write-Host "     ssh root@$VPS_IP" -ForegroundColor Cyan
Write-Host ""
Write-Host "  2. Jalankan deploy script:" -ForegroundColor White
Write-Host "     cd $REMOTE_DIR" -ForegroundColor Cyan
Write-Host "     chmod +x deploy-fresh-ubuntu24.sh" -ForegroundColor Cyan
Write-Host "     bash deploy-fresh-ubuntu24.sh" -ForegroundColor Cyan
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
