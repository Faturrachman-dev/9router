# Restore the 9router runtime DB on a fresh machine, from the PRIVATE sync repo release asset.
# Pairs with scripts\portable-export.ps1 (run on the configured source machine).
# ORDER SAFETY: download + verify FIRST; only then stop the local 9router — a failed
# download must never leave the service offline.
#
# Usage:  powershell -File scripts\portable-restore.ps1
# Then start 9router manually (custom-server.js) and verify /v1/models + one real Pi request.
param(
  [string]$Repo = "Faturrachman-dev/9router-sync",
  [string]$Tag  = "runtime-seed-latest",
  [int]$Port    = 20128
)
$ErrorActionPreference = "Stop"

function Get-SeedAsset {
  param([string]$Repo, [string]$Tag, [string]$OutDir)
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    gh release download $Tag --repo $Repo --dir $OutDir --clobber --pattern "9router-seed.sqlite"
    return (Join-Path $OutDir "9router-seed.sqlite")
  }
  # No gh: authenticate via git's credential manager (git IS required to have cloned)
  $credIn = "protocol=https`nhost=github.com`n`n"
  $credOut = $credIn | git credential fill
  $token = ($credOut | Select-String "^password=(.+)$").Matches[0].Groups[1].Value
  if (-not $token) { throw "No gh and no git credential for github.com — install gh (winget install GitHub.cli) or run 'git fetch' once to store credentials." }
  $url = "https://github.com/$Repo/releases/download/$Tag/9router-seed.sqlite"
  $file = Join-Path $OutDir "9router-seed.sqlite"
  Invoke-WebRequest -Uri $url -Headers @{ Authorization = "Bearer $token" } -OutFile $file
  return $file
}

# 1. Download the seed FIRST (service still running — failed download must not take 9router offline)
$tmp = Join-Path $env:TEMP "9router-restore"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$seed = Get-SeedAsset -Repo $Repo -Tag $Tag -OutDir $tmp
if (-not (Test-Path $seed)) { throw "Download finished but $seed is missing — aborting, 9router untouched." }

# 2. Verify the seed is a valid DB with the expected tables BEFORE touching the service
$counts = sqlite3 $seed "SELECT 'apiKeys='||count(*) FROM apiKeys
UNION ALL SELECT 'providerConnections='||count(*) FROM providerConnections
UNION ALL SELECT 'providerNodes='||count(*) FROM providerNodes
UNION ALL SELECT 'settings='||count(*) FROM settings;"
if (-not $counts -or $counts -notmatch "providerConnections=") {
  throw "Downloaded file is not a valid 9router DB — aborting, 9router untouched."
}
Write-Host "Seed verified: $counts"

# 3. Only NOW stop whatever owns the 9router port — specific PID only, never by name
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  Write-Host "Stopping 9router (PID $($conn.OwningProcess)) on port $Port..."
  Stop-Process -Id $conn.OwningProcess -Force
  Start-Sleep -Seconds 2
} else {
  Write-Host "Nothing listening on port $Port — skipping stop."
}

# 4. Swap the DB (keep a backup of whatever was there)
$dbDir = "$env:APPDATA\9router\db"
$db    = Join-Path $dbDir "data.sqlite"
if (-not (Test-Path $dbDir)) { New-Item -ItemType Directory -Force -Path $dbDir | Out-Null }
if (Test-Path $db) { Move-Item $db (Join-Path $dbDir "data.pre-restore.bak") -Force }
Remove-Item "$db-wal","$db-shm" -ErrorAction SilentlyContinue
Copy-Item $seed $db

Write-Host ""
Write-Host "Restored. Backup of previous DB: $dbDir\data.pre-restore.bak"
Write-Host "9router is STOPPED. Start it (.next\standalone\custom-server.js on port $Port), then:"
Write-Host "  - GET /v1/models should list tabbit/* and cmc/* models"
Write-Host "  - read the Pi client key locally:  sqlite3 `"$db`" `"SELECT key, name FROM apiKeys;`""
Write-Host "  - put that key into Pi's 9router provider config, make one real request"
