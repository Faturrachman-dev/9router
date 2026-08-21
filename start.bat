@echo off
cd /d "%~dp0"
set "PORT=20128"
set "HOSTNAME=127.0.0.1"

REM Always sync static assets into standalone (build doesn't copy them)
mkdir ".next\standalone\public" 2>nul
mkdir ".next\standalone\.next\static" 2>nul
xcopy /E /Y /Q "public\*" ".next\standalone\public\" >nul
xcopy /E /Y /Q ".next\static\*" ".next\standalone\.next\static\" >nul

REM Turbopack standalone omits some server chunks -> ChunkLoadError on dashboard.
REM Overlay full .next\server tree. Use node fs.cpSync: xcopy/robocopy choke on
REM turbopack's "[root-of-the-server]__*._.js" bracket filenames.
"C:\Users\hafiz\AppData\Local\hermes\node\node.exe" -e "require('fs').cpSync('.next/server','.next/standalone/.next/server',{recursive:true,force:true})" 2>nul

echo Starting 9Router on http://%HOSTNAME%:%PORT% ...
REM Pin Node 22 — better-sqlite3 ABI 127. Bare `node` (fnm default v20) falls back
REM to sql.js and silently WIPES data.sqlite. hermes node = v22.23.2.
"C:\Users\hafiz\AppData\Local\hermes\node\node.exe" .next\standalone\custom-server.js
