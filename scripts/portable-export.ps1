# Export the configured 9router runtime DB to the private repo as a release asset.
# Personal use on a private repo — deliberately unencrypted (owner's decision).
# Re-runnable: always overwrites the same asset on the same tag. No git history growth.
#
# Usage:  powershell -File scripts\portable-export.ps1
param(
  [string]$Repo = "Faturrachman-dev/9router",
  [string]$Tag  = "runtime-seed-latest",
  [string]$DbPath = "$env:APPDATA\9router\db\data.sqlite"
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path $DbPath)) { throw "Runtime DB not found: $DbPath" }

# 1. Online snapshot (safe while 9router is running)
$snap = Join-Path $env:TEMP "9router-seed.sqlite"
sqlite3 $DbPath ".backup $snap"

# 2. Sanity: what we are shipping
sqlite3 $snap "SELECT 'apiKeys='||count(*) FROM apiKeys
UNION ALL SELECT 'providerConnections='||count(*) FROM providerConnections
UNION ALL SELECT 'providerNodes='||count(*) FROM providerNodes
UNION ALL SELECT 'settings='||count(*) FROM settings;"

# 3. Create tag/release if missing, then clobber-upload the asset
cmd /c "gh release view $Tag --repo $Repo >nul 2>&1"  # PS5.1: swallow native stderr
if ($LASTEXITCODE -ne 0) {
  gh release create $Tag --repo $Repo `
    --title "9router runtime seed (latest)" `
    --notes "Plain snapshot of %APPDATA%\9router\db\data.sqlite. Private repo, personal use. portable-export.ps1 overwrites this asset every run."
}
gh release upload $Tag --repo $Repo "$snap#data.sqlite" --clobber

Write-Host ""
Write-Host "Uploaded: https://github.com/$Repo/releases/tag/$Tag (asset: data.sqlite)"
Write-Host "Snapshot kept at: $snap"
