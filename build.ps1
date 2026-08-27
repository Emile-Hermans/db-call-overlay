<#
.SYNOPSIS
    Builds the desktop app and the in-process probe.

.DESCRIPTION
    Run once after cloning, and again after changing anything in probe\ or desktop\.
    Everything lands under desktop\bin\Release\net8.0-windows\ as a normal Windows app.
#>
[CmdletBinding()]
param(
    [string]$Configuration = 'Release',
    [switch]$ProbeOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Building the probe..." -ForegroundColor Cyan
dotnet build (Join-Path $root 'probe\DbProbe.csproj') -c $Configuration --nologo -v q
if ($LASTEXITCODE -ne 0) {
    # While recording is switched on, every running API has the probe loaded and
    # Windows will not let the file be replaced. That is expected, not a failure.
    $running = @(Get-Process | Where-Object { $_.ProcessName -like 'WebApi.*' })
    if ($running.Count -gt 0) {
        Write-Host ''
        Write-Host "The probe is in use by $($running.Count) running API$(if ($running.Count -ne 1) { 's' }):" -ForegroundColor Yellow
        Write-Host "  $(($running | ForEach-Object { $_.ProcessName }) -join ', ')"
        Write-Host 'Stop them (Shift+F5 in Visual Studio) and run this again.' -ForegroundColor Yellow
        Write-Host 'Only probe\ needs them stopped - the app itself builds fine either way.'
        Write-Host ''
    }
    throw 'probe build failed'
}

$probeDll = Join-Path $root "probe\bin\$Configuration\net8.0\DbProbe.dll"
if (-not (Test-Path $probeDll)) { throw "expected $probeDll" }

if (-not $ProbeOnly) {
    $icon = Join-Path $root 'desktop\appicon.ico'
    if (-not (Test-Path $icon)) {
        Write-Host "Generating the app icon..." -ForegroundColor Cyan
        node (Join-Path $root 'tools\make-icon.mjs')
    }

    Write-Host "Building the desktop app..." -ForegroundColor Cyan
    dotnet build (Join-Path $root 'desktop\DbCallOverlay.csproj') -c $Configuration --nologo -v q
    if ($LASTEXITCODE -ne 0) { throw 'desktop build failed' }
}

$exe = Join-Path $root "desktop\bin\$Configuration\net8.0-windows\DbCallOverlay.exe"

Write-Host ''
Write-Host 'Built.' -ForegroundColor Green
Write-Host "  app   $exe"
Write-Host "  probe $probeDll"
Write-Host ''
Write-Host 'Next:  .\install-shortcut.ps1     (Desktop + Start menu entry)'
Write-Host '       .\run-api.ps1 contracts    (start an API with the probe attached)'
