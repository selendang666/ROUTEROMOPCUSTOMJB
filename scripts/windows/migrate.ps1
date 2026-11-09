#Requires -Version 5.1
<#
.SYNOPSIS
  Oh My Omop - Router — Windows Migrate (jalankan migrasi PostgreSQL saja)
.DESCRIPTION
  Wrapper tipis di atas `bun run db:migrate` + `bun run infra:status` biar jelas.
  Dipanggil: powershell -ExecutionPolicy Bypass -File ./scripts/windows/migrate.ps1
  Atau:     bun run migrate:win
#>
$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path "$PSScriptRoot/../..").Path
Set-Location $RepoRoot
Write-Host "`n▶ migrate — db:migrate" -ForegroundColor Cyan
& bun run db:migrate 2>&1 | Out-Host
$code = $LASTEXITCODE
if ($code -ne 0) {
  Write-Host "`n  ! migrate $code — cek infra:  bun run infra:status  &  .env:DATABASE_URL" -ForegroundColor Yellow
  exit $code
}
Write-Host "`n▶ status — infra:status" -ForegroundColor Cyan
& bun run infra:status 2>&1 | Out-Host
Write-Host "`n  ✓ migrate done" -ForegroundColor Green
