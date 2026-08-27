<#
.SYNOPSIS
    Puts DB Call Overlay on the Desktop and in the Start menu.

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
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'DB Call Overlay.lnk')
    (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\DB Call Overlay.lnk')
)

if ($Remove) {
    foreach ($target in $targets) {
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

$shell = New-Object -ComObject WScript.Shell
foreach ($target in $targets) {
    $parent = Split-Path -Parent $target
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }

    $link = $shell.CreateShortcut($target)
    $link.TargetPath = $exe
    $link.WorkingDirectory = Split-Path -Parent $exe
    $link.IconLocation = "$exe,0"
    $link.Description = 'Shows which database calls each click in your app causes'
    $link.Save()
    Write-Host "created $target" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Open it from the Desktop or the Start menu - it starts everything it needs.'
