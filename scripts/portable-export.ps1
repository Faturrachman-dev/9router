# Export the configured 9router runtime DB as a release asset on the PRIVATE sync repo.
# SECURITY: the asset contains LIVE provider credentials and must NEVER go to a public
# repo (e.g. Faturrachman-dev/9router is public). Default targets the private
# Faturrachman-dev/9router-sync. No encryption by owner's choice — repo privacy is the control.
#
# Usage:  powershell -File scripts\portable-export.ps1
param(
  [string]$Repo = "Faturrachman-dev/9router-sync",
  [string]$Tag  = "runtime-seed-latest",
  [string]$DbPath = "$env:APPDATA\9router\db\data.sqlite"
)
$ErrorActionPreference = "Stop"

if ($Repo -eq "Faturrachman-dev/9router") {
  throw "Refusing to upload a credential-bearing DB to the PUBLIC 9router repo. Use the private 9router-sync repo."
}
if (-not (Test-Path $DbPath)) { throw "Runtime DB not found: $DbPath" }

# 1. Online snapshot (safe while 9router is running)
$snap = Join-Path $env:TEMP "9router-seed.sqlite"
sqlite3 $DbPath ".backup $snap"

# 2. Sanity: what we are shipping
sqlite3 $snap "SELECT 'apiKeys='||count(*) FROM apiKeys
UNION ALL SELECT 'providerConnections='||count(*) FROM providerConnections
UNION ALL SELECT 'providerNodes='||count(*) FROM providerNodes
UNION ALL SELECT 'settings='||count(*) FROM settings;"

# 3. Create tag/release if missing, then clobber-upload the asset.
#    cmd /c wrapper: PS 5.1 turns native stderr into a terminating error otherwise.
cmd /c "gh release view $Tag --repo $Repo >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
  gh release create $Tag --repo $Repo `
    --title "9router runtime seed (latest)" `
    --notes "Plain 9router runtime DB snapshot (PRIVATE repo, personal use). portable-export.ps1 overwrites this asset every run."
}
gh release upload $Tag --repo $Repo "$snap#9router-seed.sqlite" --clobber

Write-Host ""
Write-Host "Uploaded: https://github.com/$Repo/releases/tag/$Tag (asset: 9router-seed.sqlite)"
Write-Host "Snapshot kept at: $snap"
