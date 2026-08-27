<#
.SYNOPSIS
    Opens the DB Call Overlay app (building it first if needed).

.DESCRIPTION
    The app starts and supervises the collector itself, so this is the only thing
    you need to run. Double-clicking the Desktop shortcut does exactly the same -
    see install-shortcut.ps1.
#>
[CmdletBinding()]
param(
    [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root "desktop\bin\$Configuration\net8.0-windows\DbCallOverlay.exe"

if (-not (Test-Path $exe)) {
    Write-Host 'App not built yet - building it now...' -ForegroundColor Yellow
    & (Join-Path $root 'build.ps1') -Configuration $Configuration
}

Start-Process $exe
Write-Host 'DB Call Overlay opened.' -ForegroundColor Green
