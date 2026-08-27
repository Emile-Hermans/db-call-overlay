<#
.SYNOPSIS
    Installs DB Call Overlay: checks what is needed, builds it, and puts it on the
    Desktop and in the Start menu.

.DESCRIPTION
    Run this by double-clicking Install.cmd. Nothing is written outside this folder
    except the two shortcuts, and Uninstall.cmd reverses all of it.

.EXAMPLE
    .\install.ps1
    .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root 'desktop\bin\Release\net8.0-windows\DbCallOverlay.exe'

$shortcuts = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'DB Call Overlay.lnk')
    (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\DB Call Overlay.lnk')
)

function Write-Step($text) { Write-Host "  $text" }
function Write-Ok($text) { Write-Host "  [ok] $text" -ForegroundColor Green }
function Write-Bad($text) { Write-Host "  [!!] $text" -ForegroundColor Red }

Write-Host ''
Write-Host '  DB Call Overlay' -ForegroundColor Cyan
Write-Host '  ---------------' -ForegroundColor Cyan
Write-Host ''

# ---------------------------------------------------------------- uninstall

if ($Uninstall) {
    foreach ($shortcut in $shortcuts) {
        if (Test-Path $shortcut) { Remove-Item $shortcut -Force; Write-Ok "removed $(Split-Path -Leaf $shortcut)" }
    }

    # Take the recorder back out of the environment, or dotnet commands would keep
    # trying to load a file that may no longer be there.
    if ([Environment]::GetEnvironmentVariable('DOTNET_STARTUP_HOOKS', 'User')) {
        [Environment]::SetEnvironmentVariable('DOTNET_STARTUP_HOOKS', $null, 'User')
        [Environment]::SetEnvironmentVariable('DBPROBE_APPS', $null, 'User')
        Write-Ok 'recording switched off'
    }

    Get-Process DbCallOverlay -ErrorAction SilentlyContinue | Stop-Process -Force
    Write-Host ''
    Write-Host '  Uninstalled. Delete this folder to remove the rest.' -ForegroundColor Green
    Write-Host '  Your recordings in data\ were left alone.'
    Write-Host ''
    return
}

# ------------------------------------------------------------ prerequisites

Write-Host '  Checking what is needed...'
$missing = @()

$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if ($dotnet) {
    $sdks = & dotnet --list-sdks 2>$null
    if ($sdks) { Write-Ok ".NET SDK ($(($sdks | Select-Object -Last 1) -replace ' \[.*$',''))" }
    else { $missing += '.NET SDK 8 or newer - https://dotnet.microsoft.com/download'; Write-Bad '.NET SDK (runtime only, no SDK)' }
}
else {
    $missing += '.NET SDK 8 or newer - https://dotnet.microsoft.com/download'
    Write-Bad '.NET SDK not found'
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { Write-Ok "Node.js $(& node --version)" }
else { $missing += 'Node.js 18 or newer - https://nodejs.org'; Write-Bad 'Node.js not found' }

# WebView2 ships with Windows 11 and with any recent Edge; only warn.
$webview = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($webview) { Write-Ok 'WebView2 runtime' }
else { Write-Host '  [--] WebView2 runtime not detected - the app will offer the download if it is really missing' -ForegroundColor DarkYellow }

if ($missing.Count -gt 0) {
    Write-Host ''
    Write-Host '  Install these first, then run Install.cmd again:' -ForegroundColor Yellow
    $missing | ForEach-Object { Write-Host "    - $_" }
    Write-Host ''
    exit 1
}

# -------------------------------------------------------------------- build

Write-Host ''
Write-Host '  Building...'

# The recorder cannot be replaced while an application has it loaded. Only this
# copy matters - another checkout's DbProbe.dll is a different file.
$probeDll = Join-Path $root 'probe\bin\Release\net8.0\DbProbe.dll'
if (Test-Path $probeDll) {
    $full = (Resolve-Path $probeDll).Path
    $loaded = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Modules | Where-Object { $_.FileName -eq $full } } catch { $false }
    })

    if ($loaded.Count -gt 0) {
        Write-Host ''
        Write-Bad "The recorder is in use by: $(($loaded | ForEach-Object { $_.ProcessName } | Select-Object -Unique) -join ', ')"
        Write-Host '       Stop those applications and run Install.cmd again.'
        Write-Host ''
        exit 1
    }
}

Get-Process DbCallOverlay -ErrorAction SilentlyContinue | Stop-Process -Force

& dotnet build (Join-Path $root 'probe\DbProbe.csproj') -c Release --nologo -v quiet
if ($LASTEXITCODE -ne 0) { Write-Bad 'the recorder failed to build'; exit 1 }
Write-Ok 'recorder'

if (-not (Test-Path (Join-Path $root 'desktop\appicon.ico'))) {
    & node (Join-Path $root 'tools\make-icon.mjs') | Out-Null
}

& dotnet build (Join-Path $root 'desktop\DbCallOverlay.csproj') -c Release --nologo -v quiet
if ($LASTEXITCODE -ne 0) { Write-Bad 'the app failed to build'; exit 1 }
Write-Ok 'app'

if (-not (Test-Path $exe)) { Write-Bad "expected $exe"; exit 1 }

# ---------------------------------------------------------------- shortcuts

$shell = New-Object -ComObject WScript.Shell
foreach ($shortcut in $shortcuts) {
    $parent = Split-Path -Parent $shortcut
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }

    $link = $shell.CreateShortcut($shortcut)
    $link.TargetPath = $exe
    $link.WorkingDirectory = Split-Path -Parent $exe
    $link.IconLocation = "$exe,0"
    $link.Description = 'Shows which database calls each click in your app causes'
    $link.Save()
}
Write-Ok 'shortcut on the Desktop and in the Start menu'

# --------------------------------------------------------------------- done

Write-Host ''
Write-Host '  Installed.' -ForegroundColor Green
Write-Host ''
Write-Host '  Next:'
Write-Host '    1. Open DB Call Overlay from the Desktop.'
Write-Host '    2. Press "Switch recording on" - that is the only setup.'
Write-Host '    3. Start your API, click around, watch the calls appear.'
Write-Host ''
Write-Host '  Optional: load the browser extension so calls are grouped per button'
Write-Host '  you click. chrome://extensions -> Developer mode -> Load unpacked ->'
Write-Host "  $(Join-Path $root 'extension')"
Write-Host ''
Write-Host '  Uninstall.cmd removes the shortcuts and switches recording off.'
Write-Host ''

if (-not $NoLaunch) {
    Start-Process $exe
}
