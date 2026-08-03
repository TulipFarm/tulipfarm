#Requires -Version 5
<#
.SYNOPSIS
  TulipFarm installer for Windows — thin WSL2 bootstrap.
.DESCRIPTION
  Per spec INSTALLATION.md, Windows runs the Linux install path inside WSL2.
  This script verifies WSL2 (+ a distro) is present and then runs the bash one-liner
  (scripts/install.sh) inside WSL, forwarding version/host overrides.

  Usage (PowerShell):
    irm https://tulipfarm.site/install.ps1 | iex
  To override defaults, download then run with params:
    ./install.ps1 -Version v0.1.0
.PARAMETER Version
  App image tag (TF_VERSION). Default: latest.
.PARAMETER BaseUrl
  Base URL for fetched files. Default: https://tulipfarm.site.
.PARAMETER Ref
  Git ref under BaseUrl. Empty (the default) means the flat layout the site serves; set it
  together with -BaseUrl https://raw.githubusercontent.com/TulipFarm/tulipfarm to install
  an exact ref from GitHub.
#>
[CmdletBinding()]
param(
  [string]$Version = "latest",
  [string]$BaseUrl = "https://tulipfarm.site",
  [string]$Ref = ""
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
# The site serves a flat layout (/install.sh); a ref pulls the repo path from GitHub raw.
$scriptUrl = if ($Ref) { "$BaseUrl/$Ref/scripts/install.sh" } else { "$BaseUrl/install.sh" }
$inner = "export TF_VERSION='$Version' TF_BASE_URL='$BaseUrl' TF_REF='$Ref'; " +
         "curl -fsSL `"$scriptUrl`" | sudo -E bash"
& wsl.exe -e bash -lc $inner
if ($LASTEXITCODE -ne 0) { Die "installer failed inside WSL (exit $LASTEXITCODE)" }

Write-Info "Done. Open the printed URL in your Windows browser to finish setup."
