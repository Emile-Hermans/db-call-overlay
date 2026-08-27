<#
.SYNOPSIS
    Opens Visual Studio with the recorder attached to everything you F5 from it.

.DESCRIPTION
    An alternative to switching recording on machine-wide. Visual Studio passes its
    own environment to every project it debugs, so starting it from here is enough -
    but only for this one Visual Studio session.

    Most people should just open the app and press "Switch recording on" instead;
    that survives restarts and needs no script.

.EXAMPLE
    .\start-vs.ps1 .\MyApp.sln
    .\start-vs.ps1              # finds a .sln near this folder
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Solution,

    [ValidateSet('full', 'nofile', 'off')]
    [string]$Stack = 'full',

    [switch]$RawSql
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$probe = Join-Path $root 'probe\bin\Release\net8.0\DbProbe.dll'
if (-not (Test-Path $probe)) {
    Write-Host 'Recorder not built yet - building it now...' -ForegroundColor Yellow
    & (Join-Path $root 'build.ps1') -ProbeOnly
}

if (-not $Solution) {
    $Solution = Get-ChildItem (Split-Path -Parent $root) -Recurse -Depth 3 -Filter *.sln -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $Solution) { throw 'No .sln found nearby - pass one: .\start-vs.ps1 <path to .sln>' }
    Write-Host "Using $Solution" -ForegroundColor DarkGray
}
if (-not (Test-Path $Solution)) { throw "Solution not found: $Solution" }

if (Get-Process devenv -ErrorAction SilentlyContinue) {
    Write-Warning 'Visual Studio is already running.'
    Write-Warning 'Close it first - a running VS keeps the environment it started with,'
    Write-Warning 'so anything you debug from it would still not be recorded.'
    if ((Read-Host 'Open a second Visual Studio anyway? (y/N)') -ne 'y') { return }
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$devenv = $null
if (Test-Path $vswhere) { $devenv = & $vswhere -latest -prerelease -property productPath 2>$null }
if (-not $devenv -or -not (Test-Path $devenv)) {
    $devenv = Get-ChildItem "$env:ProgramFiles\Microsoft Visual Studio\*\*\Common7\IDE\devenv.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $devenv) { throw 'Could not find devenv.exe. Use the app''s "Switch recording on" button instead.' }

$env:DOTNET_STARTUP_HOOKS = $probe
$env:DBPROBE_STACK = $Stack
$env:DBPROBE_RAWSQL = $(if ($RawSql) { 'on' } else { 'off' })

Write-Host "Opening $Solution with the recorder attached..." -ForegroundColor Cyan
Start-Process $devenv -ArgumentList "`"$Solution`""

Write-Host ''
Write-Host 'Press F5 as usual - what you debug will show up in DB Call Overlay.' -ForegroundColor Green
