@echo off
cd /d "C:\Users\hafiz\tools\9router"

echo === Stopping 9Router ===
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 20128 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }" 2>nul
timeout /t 2 /nobreak >nul

REM Drop ONLY the stale standalone output (it can hold locks / stale server.js).
REM NEVER delete .next or .next\cache — that cache is what keeps the build
REM incremental (~30s instead of a ~2.6min cold compile). "rm -rf .next" is the
REM #1 cause of slow rebuilds here; don't do it.
if exist ".next\standalone" rmdir /S /Q ".next\standalone"

echo === Building (incremental, turbopack) ===
call npm run build
if %ERRORLEVEL% neq 0 (
    echo BUILD FAILED
    pause
    exit /b 1
)

echo === Syncing static assets ===
mkdir ".next\standalone\public" 2>nul
mkdir ".next\standalone\.next\static" 2>nul
xcopy /E /Y /Q "public\*" ".next\standalone\public\" >nul
xcopy /E /Y /Q ".next\static\*" ".next\standalone\.next\static\" >nul

echo === Starting 9Router ===
set "PORT=20128"
set "HOSTNAME=127.0.0.1"
REM Pin Node 22 — better-sqlite3 ABI 127. Bare `node` (fnm default v20) falls back
REM to sql.js and silently WIPES data.sqlite. hermes node = v22.23.2.
start "9Router" /B "C:\Users\hafiz\AppData\Local\hermes\node\node.exe" .next\standalone\server.js

echo === Verifying ===
timeout /t 3 /nobreak >nul
curl -s http://127.0.0.1:20128/api/health 2>nul
if %ERRORLEVEL% equ 0 (
    echo 9Router is UP on :20128
) else (
    echo 9Router may still be starting...
)
