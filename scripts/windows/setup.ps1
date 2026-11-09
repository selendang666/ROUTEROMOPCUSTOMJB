#Requires -Version 5.1
<#
.SYNOPSIS
  Oh My Omop - Router — Windows Setup (thin wrapper)
.DESCRIPTION
  Thin wrapper around the cross-OS unified setup (scripts/setup.ts).
  Prefer: bun run setup  (works on Windows/macOS/Linux).
  This ps1 is kept for double-click / PowerShell-native ergonomics.
#>
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$RepoRoot = (Resolve-Path "$PSScriptRoot/../..").Path
Set-Location $RepoRoot
& bun run setup @args
exit $LASTEXITCODE
