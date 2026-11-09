#Requires -Version 5.1
<#
.SYNOPSIS
  Oh My Omop - Router — Windows Stop (matikan dev server + infra)
.DESCRIPTION
  1) Kill proses di PORT (backend) & 5173 (dashboard vite) jika ada
  2) infra:down (Docker Compose down / Laragon stop)
  Dipanggil: powershell -ExecutionPolicy Bypass -File ./scripts/windows/stop.ps1 [-KeepInfra]
  Atau:     bun run stop:win
.PARAMETER KeepInfra
  Jangan `infra:down` — cuma kill proses dev.
#>
param([switch]$KeepInfra)
$ErrorActionPreference = "SilentlyContinue"
$RepoRoot = (Resolve-Path "$PSScriptRoot/../..").Path
Set-Location $RepoRoot

function KillPort($port, $label) {
  $pids = @()
  try {
    $conns = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
  } catch {}
  if (-not $pids -or $pids.Count -eq 0) {
    # Fallback netstat (butuh admin kadang)
    $lines = netstat -ano 2>$null | Select-String ":$port\s"
    foreach ($l in $lines) { $tok = ($l.ToString().Trim() -split "\s+")[-1]; if ($tok -match "^\d+$") { $pids += [int]$tok } }
    $pids = $pids | Sort-Object -Unique
  }
  foreach ($pid in $pids) {
    if ($pid -le 4) { continue }
    try {
      $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
      $name = if ($proc) { $proc.ProcessName } else { "pid $pid" }
      Write-Host "  · kill $label :$port → $name ($pid)" -ForegroundColor Yellow
      Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    } catch {}
  }
  if (-not $pids -or $pids.Count -eq 0) { Write-Host "  · $label :$port — tidak ada proses" -ForegroundColor DarkGray }
}

# Baca PORT dari .env jika ada, else 3000
$Port = 3000
if (Test-Path "$RepoRoot/.env") {
  $m = Select-String -Path "$RepoRoot/.env" -Pattern "^\s*PORT\s*=\s*(\d+)" | Select-Object -First 1
  if ($m -and $m.Matches[0].Groups[1].Value) { $Port = [int]$m.Matches[0].Groups[1].Value }
}
Write-Host "`n▶ stop — kill dev (backend :$Port, dashboard :5173)" -ForegroundColor Cyan
KillPort $Port "backend"
KillPort 5173 "dashboard"
# Juga kill bun/vite yang orphan (opsional, hati-hati)
# Get-Process bun,node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*ohmyomop-router*" } | Stop-Process -Force

if (-not $KeepInfra) {
  Write-Host "`n▶ infra:down" -ForegroundColor Cyan
  & bun run infra:down 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Host "  ! infra:down $($LASTEXITCODE) — cek docker" -ForegroundColor Yellow }
} else {
  Write-Host "`n  · keep infra (--KeepInfra), skip infra:down" -ForegroundColor DarkGray
}
Write-Host "`n  ✓ stop done" -ForegroundColor Green
