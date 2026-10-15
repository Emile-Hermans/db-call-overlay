<#
.SYNOPSIS
    Puts Clicktrace on the Desktop and in the Start menu.

.EXAMPLE
    .\install-shortcut.ps1
    .\install-shortcut.ps1 -Remove
#>
[CmdletBinding()]
param(
    [string]$Configuration = 'Release',
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root "desktop\bin\$Configuration\net8.0-windows\DbCallOverlay.exe"

$targets = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Clicktrace.lnk')
    (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Clicktrace.lnk')
)

# The app was called DB Call Overlay before; its shortcuts are replaced, not left behind.
$legacyShortcuts = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'DB Call Overlay.lnk')
    (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\DB Call Overlay.lnk')
)

if ($Remove) {
    foreach ($target in $targets + $legacyShortcuts) {
        if (Test-Path $target) {
            Remove-Item $target -Force
            Write-Host "removed $target"
        }
    }
    return
}

if (-not (Test-Path $exe)) {
    Write-Host 'App not built yet - building it now...' -ForegroundColor Yellow
    & (Join-Path $root 'build.ps1') -Configuration $Configuration
}

foreach ($legacy in $legacyShortcuts) { if (Test-Path $legacy) { Remove-Item $legacy -Force } }

$shell = New-Object -ComObject WScript.Shell
foreach ($target in $targets) {
    $parent = Split-Path -Parent $target
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }

    $link = $shell.CreateShortcut($target)
    $link.TargetPath = $exe
    $link.WorkingDirectory = Split-Path -Parent $exe
    $link.IconLocation = "$exe,0"
    $link.Description = 'Clicktrace - what every click in your app costs the database, and why it is slow'
    $link.Save()
    Write-Host "created $target" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Open it from the Desktop or the Start menu - it starts everything it needs.'
