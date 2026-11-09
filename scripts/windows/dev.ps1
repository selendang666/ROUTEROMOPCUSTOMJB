#Requires -Version 5.1
<#
.SYNOPSIS
  Oh My Omop - Router — Windows Dev (backend + dashboard barengan, enak)
.DESCRIPTION
  Start backend `bun run --watch src/main.ts` dan dashboard `vite` barengan.
  - Log diprefix [backend] / [dashboard]
  - Ctrl+C matikan keduanya (stop.ps1 dipanggil otomatis)
  - Port baca dari .env:PORT else 3000, dashboard 5173
  Dipanggil: powershell -ExecutionPolicy Bypass -File ./scripts/windows/dev.ps1
  Atau:     bun run dev:all   (cross-platform, pakai scripts/dev-all.ts)
#>
$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path "$PSScriptRoot/../..").Path
Set-Location $RepoRoot

# Baca PORT
$Port = 3000
if (Test-Path "$RepoRoot/.env") {
  $m = Select-String -Path "$RepoRoot/.env" -Pattern "^\s*PORT\s*=\s*(\d+)" | Select-Object -First 1
  if ($m -and $m.Matches[0].Groups[1].Value) { $Port = [int]$m.Matches[0].Groups[1].Value }
}
$DashboardPort = 5173

Write-Host "`n▶ dev:all — backend :$Port + dashboard :$DashboardPort (Ctrl+C untuk stop)`n" -ForegroundColor Cyan
Write-Host "  backend   → http://localhost:$Port  (proxy /v1/*, console /console/api/*)" -ForegroundColor DarkGray
Write-Host "  dashboard → http://localhost:$DashboardPort" -ForegroundColor DarkGray
Write-Host "  log prefix: [backend] / [dashboard]`n" -ForegroundColor DarkGray

# Cek port bentrok — tawarkan kill
function TestPort($p) {
  try { $c = Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue; return ($c -and $c.Count -gt 0) } catch { return $false }
}
if (TestPort $Port)   { Write-Host "  ! :$Port sudah dipakai — kill dulu? (Y/n)" -ForegroundColor Yellow -NoNewline; $a = Read-Host " "; if ($a -ne "n") { & "$PSScriptRoot/stop.ps1" -KeepInfra } }
if (TestPort $DashboardPort) { Write-Host "  ! :$DashboardPort sudah dipakai — kill dulu? (Y/n)" -ForegroundColor Yellow -NoNewline; $a = Read-Host " "; if ($a -ne "n") { & "$PSScriptRoot/stop.ps1" -KeepInfra } }

# Pakai Start-Process biar bisa prefix log; atau fallback ke jobs
$backendCmd = "bun run --watch src/main.ts"
$dashCmd    = "bun run --cwd dashboard dev"

# Prefer `bun run scripts/dev-all.ts` yang cross-platform — tapi di ps1 ini kita pakai jobs native biar gak butuh concurrently
$jobs = @()

# Backend job
$jobs += Start-Job -Name "backend" -ScriptBlock {
  param($Root, $Cmd)
  Set-Location $Root
  # Bun --watch butuh foreground; jalankan via cmd /c biar streaming
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "cmd.exe"
  $psi.Arguments = "/c $Cmd 2>&1"
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  while (-not $p.HasExited) {
    $line = $p.StandardOutput.ReadLine()
    if ($null -ne $line) { Write-Host "[backend] $line" }
  }
} -ArgumentList $RepoRoot, $backendCmd

# Dashboard job
$jobs += Start-Job -Name "dashboard" -ScriptBlock {
  param($Root, $Cmd)
  Set-Location $Root
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "cmd.exe"
  $psi.Arguments = "/c $Cmd 2>&1"
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  while (-not $p.HasExited) {
    $line = $p.StandardOutput.ReadLine()
    if ($null -ne $line) { Write-Host "[dashboard] $line" }
  }
} -ArgumentList $RepoRoot, $dashCmd

# Stream job output ke host
try {
  Write-Host "  ▶ jobs started: backend=$($jobs[0].Id), dashboard=$($jobs[1].Id) — streaming log...`n" -ForegroundColor Green
  while ($true) {
    foreach ($j in $jobs) {
      $out = Receive-Job -Job $j -Keep 2>&1
      if ($out) { $out | ForEach-Object { Write-Host $_ } }
      if ($j.State -eq "Failed" -or $j.State -eq "Completed") {
        Write-Host "`n  ! job $($j.Name) $($j.State) — cek log di atas" -ForegroundColor Yellow
      }
    }
    Start-Sleep -Milliseconds 300
  }
} finally {
  Write-Host "`n`n▶ Ctrl+C — stop jobs..." -ForegroundColor Cyan
  foreach ($j in $jobs) { try { Stop-Job $j -ErrorAction SilentlyContinue; Remove-Job $j -Force -ErrorAction SilentlyContinue } catch {} }
  # Kill port juga biar bersih
  & "$PSScriptRoot/stop.ps1" -KeepInfra
  Write-Host "  ✓ dev stopped" -ForegroundColor Green
}
