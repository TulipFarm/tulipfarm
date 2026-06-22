#Requires -Version 5
<#
.SYNOPSIS
  TulipFarm installer for Windows — thin WSL2 bootstrap.
.DESCRIPTION
  Per spec INSTALLATION.md INST-002, Windows runs the Linux install path inside WSL2.
  This script verifies WSL2 (+ a distro) is present and then runs the bash one-liner
  (scripts/get.tulipfarm.sh) inside WSL, forwarding version/host overrides.

  Usage (PowerShell):
    irm https://raw.githubusercontent.com/TulipFarm/tulipfarm/main/scripts/install.ps1 | iex
  To override defaults, download then run with params:
    ./install.ps1 -Version v0.1.0
.PARAMETER Version
  App image tag (TF_VERSION). Default: latest.
.PARAMETER BaseUrl
  Raw base URL for fetched files. Default: GitHub raw.
.PARAMETER Ref
  Git ref under BaseUrl. Default: main.
#>
[CmdletBinding()]
param(
  [string]$Version = "latest",
  [string]$BaseUrl = "https://raw.githubusercontent.com/TulipFarm/tulipfarm",
  [string]$Ref = "main"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Info($m) { Write-Host "> $m" -ForegroundColor Green }
function Write-Note($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "x $m" -ForegroundColor Red; exit 1 }

# 1. WSL present?
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
  Write-Note "WSL2 is required to run TulipFarm on Windows."
  Write-Host "Install it from an elevated PowerShell, reboot, then re-run this installer:"
  Write-Host "    wsl --install"
  Die "WSL2 not found."
}

# 2. A Linux distro installed?  (`wsl -l -q` lists installed distros; empty => none)
$distros = (& wsl.exe -l -q) 2>$null | Where-Object { $_ -and $_.Trim() -ne "" }
if (-not $distros) {
  Write-Note "WSL is present but no Linux distribution is installed."
  Write-Host "Install one, then re-run this installer:"
  Write-Host "    wsl --install -d Ubuntu"
  Die "No WSL distribution found."
}

Write-Info "WSL detected - running the Linux installer inside WSL..."

# 3. Run the bash one-liner inside WSL, forwarding overrides. `sudo -E` keeps the TF_* env.
$inner = "export TF_VERSION='$Version' TF_BASE_URL='$BaseUrl' TF_REF='$Ref'; " +
         "curl -fsSL `"$BaseUrl/$Ref/scripts/get.tulipfarm.sh`" | sudo -E bash"
& wsl.exe -e bash -lc $inner
if ($LASTEXITCODE -ne 0) { Die "installer failed inside WSL (exit $LASTEXITCODE)" }

Write-Info "Done. Open the printed URL in your Windows browser to finish setup."
