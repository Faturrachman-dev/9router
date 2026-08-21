# 9router interactive TUI — arrow-key menu (default: Status).
# Invoked by bin\9router.bat when run with no args (or `9router menu`).
# Flagged subcommands (--start/--stop/--status/...) still go straight to the .bat.
param([string]$Action = "")

$ErrorActionPreference = "SilentlyContinue"
$Port = 20128
$Base = "http://127.0.0.1:$Port"
$Bat  = "C:\Users\hafiz\bin\9router.bat"

function Get-Status {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($c) {
        $procId = @($c.OwningProcess)[0]
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        return [pscustomobject]@{ Running = $true; Pid = $p.Id; Name = $p.ProcessName }
    }
    return [pscustomobject]@{ Running = $false }
}

function Show-Status {
    $s = Get-Status
    if ($s.Running) {
        Write-Host "  9Router RUNNING" -ForegroundColor Green -NoNewline
        Write-Host "   PID $($s.Pid) ($($s.Name))   $Base"
        try {
            $h = Invoke-RestMethod "$Base/api/health" -TimeoutSec 2
            if ($h.ok) { Write-Host "  health: ok" -ForegroundColor Green }
            else       { Write-Host "  health: $($h | ConvertTo-Json -Compress)" -ForegroundColor Yellow }
        } catch { Write-Host "  health: not responding" -ForegroundColor Yellow }
    } else {
        Write-Host "  9Router STOPPED" -ForegroundColor Red
    }
}

function Show-Models {
    $s = Get-Status
    if (-not $s.Running) { Write-Host "  (server stopped - start it to list models)" -ForegroundColor Yellow; return }
    try { $r = Invoke-RestMethod "$Base/v1/models" -TimeoutSec 5 }
    catch { Write-Host "  failed to fetch /v1/models" -ForegroundColor Red; return }
    $models = if ($r.data) { $r.data } else { $r }
    Write-Host "  Active models: $($models.Count)" -ForegroundColor Cyan
    Write-Host ""
    $groups = $models | Group-Object { ($_.id -split '/')[0] } | Sort-Object Name
    foreach ($g in $groups) {
        Write-Host ("  {0} ({1})" -f $g.Name, $g.Count) -ForegroundColor White
        foreach ($m in $g.Group) { Write-Host "     $($m.id)" -ForegroundColor DarkGray }
    }
}

function Invoke-Bat([string]$flag) {
    & cmd.exe /c "`"$Bat`" $flag"
}

# Run a single action non-interactively (used by `9router-menu.ps1 -Action status`)
function Invoke-Action([string]$a) {
    switch ($a.ToLower()) {
        "status"  { Show-Status }
        "models"  { Show-Models }
        "start"   { Invoke-Bat "--start" }
        "stop"    { Invoke-Bat "--stop" }
        "restart" { Invoke-Bat "--restart" }
        "rebuild" { Invoke-Bat "--rebuild" }
        default   { Show-Status }
    }
}

function Show-Menu {
    $items = @(
        @{ Key = "Status";      Act = "status";  Desc = "Running state + health" },
        @{ Key = "List models"; Act = "models";  Desc = "Active models from live catalog" },
        @{ Key = "Start";       Act = "start";   Desc = "Start 9Router (:$Port)" },
        @{ Key = "Stop";        Act = "stop";    Desc = "Stop 9Router" },
        @{ Key = "Restart";     Act = "restart"; Desc = "Stop then start (no build)" },
        @{ Key = "Rebuild";     Act = "rebuild"; Desc = "Build + restart" },
        @{ Key = "Exit";        Act = "exit";    Desc = "" }
    )
    $sel = 0
    while ($true) {
        Clear-Host
        Write-Host ""
        Write-Host "  9ROUTER" -ForegroundColor Cyan -NoNewline
        $s = Get-Status
        if ($s.Running) { Write-Host "   * running  PID $($s.Pid)" -ForegroundColor Green }
        else            { Write-Host "   * stopped" -ForegroundColor Red }
        Write-Host "  up/down select   Enter run   Esc quit" -ForegroundColor DarkGray
        Write-Host ""
        for ($i = 0; $i -lt $items.Count; $i++) {
            $label = "  " + $items[$i].Key.PadRight(13)
            if ($i -eq $sel) {
                Write-Host (" >" + $label) -ForegroundColor Black -BackgroundColor Cyan -NoNewline
                Write-Host ("  " + $items[$i].Desc) -ForegroundColor DarkGray
            } else {
                Write-Host ("  " + $label) -NoNewline
                Write-Host ("  " + $items[$i].Desc) -ForegroundColor DarkGray
            }
        }
        $k = [Console]::ReadKey($true)
        switch ($k.Key) {
            "UpArrow"   { $sel = ($sel - 1 + $items.Count) % $items.Count }
            "DownArrow" { $sel = ($sel + 1) % $items.Count }
            "Escape"    { return }
            "Enter"     {
                $act = $items[$sel].Act
                if ($act -eq "exit") { return }
                Clear-Host; Write-Host ""
                Invoke-Action $act
                Write-Host ""
                Write-Host "  Enter = back   Esc = quit" -ForegroundColor DarkGray
                $kk = [Console]::ReadKey($true)
                if ($kk.Key -eq "Escape") { return }
            }
        }
    }
}

if ($Action) { Invoke-Action $Action } else { Show-Menu }
