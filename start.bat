@echo off
cd /d "%~dp0"
set "PORT=20128"
set "HOSTNAME=127.0.0.1"

REM Always sync static assets into standalone (build doesn't copy them)
mkdir ".next\standalone\public" 2>nul
mkdir ".next\standalone\.next\static" 2>nul
xcopy /E /Y /Q "public\*" ".next\standalone\public\" >nul
xcopy /E /Y /Q ".next\static\*" ".next\standalone\.next\static\" >nul

echo Starting 9Router on http://%HOSTNAME%:%PORT% ...
REM Pin Node 22 — better-sqlite3 ABI 127. Bare `node` (fnm default v20) falls back
REM to sql.js and silently WIPES data.sqlite. hermes node = v22.23.2.
"C:\Users\hafiz\AppData\Local\hermes\node\node.exe" .next\standalone\server.js
