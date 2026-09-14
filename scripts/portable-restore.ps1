# Restore the 9router runtime DB on a fresh machine, from the private repo release asset.
# Pairs with scripts\portable-export.ps1 (run on the configured source machine).
#
# Usage:  powershell -File scripts\portable-restore.ps1
# Then start 9router manually (custom-server.js) and verify /v1/models + one real Pi request.
param(
  [string]$Repo = "Faturrachman-dev/9router",
  [string]$Tag  = "runtime-seed-latest",
  [int]$Port    = 20128
)
$ErrorActionPreference = "Stop"

# 1. Stop whatever owns the 9router port — specific PID only, never kill by name
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  Write-Host "Stopping 9router (PID $($conn.OwningProcess)) on port $Port..."
  Stop-Process -Id $conn.OwningProcess -Force
  Start-Sleep -Seconds 2
} else {
  Write-Host "Nothing listening on port $Port — skipping stop."
}

# 2. Download the seed
$tmp = Join-Path $env:TEMP "9router-restore"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
gh release download $Tag --repo $Repo --dir $tmp --clobber --pattern "data.sqlite"

# 3. Swap the DB (keep a backup of whatever was there)
$dbDir = "$env:APPDATA\9router\db"
$db    = Join-Path $dbDir "data.sqlite"
if (-not (Test-Path $dbDir)) { New-Item -ItemType Directory -Force -Path $dbDir | Out-Null }
if (Test-Path $db) { Move-Item $db (Join-Path $dbDir "data.pre-restore.bak") -Force }
Remove-Item "$db-wal","$db-shm" -ErrorAction SilentlyContinue
Copy-Item (Join-Path $tmp "data.sqlite") $db

# 4. Verify what landed
Write-Host ""
sqlite3 $db "SELECT 'apiKeys='||count(*) FROM apiKeys
UNION ALL SELECT 'providerConnections='||count(*) FROM providerConnections
UNION ALL SELECT 'providerNodes='||count(*) FROM providerNodes
UNION ALL SELECT 'settings='||count(*) FROM settings;"

Write-Host ""
Write-Host "Restored. Backup of previous DB: $dbDir\data.pre-restore.bak"
Write-Host "Next: start 9router (.next\standalone\custom-server.js on port $Port), then:"
Write-Host "  - GET /v1/models should list tabbit/* and cmc/* models"
Write-Host "  - read the Pi client key locally:  sqlite3 `"$db`" `"SELECT * FROM apiKeys;`""
Write-Host "  - put that key into Pi's 9router provider config, make one real request"
