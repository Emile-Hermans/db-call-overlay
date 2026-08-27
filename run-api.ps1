<#
.SYNOPSIS
    Starts one or more .NET projects with the recorder attached.

.DESCRIPTION
    For running an API from a terminal without switching recording on for the whole
    machine. The environment variable is set for the child process only - nothing is
    installed, and none of your own files are touched.

    Most people do not need this: open the app and press "Switch recording on".

.EXAMPLE
    .\run-api.ps1 .\src\MyApi\MyApi.csproj
    .\run-api.ps1 .\src\Api\Api.csproj .\src\Worker\Worker.csproj
    .\run-api.ps1 -Solution .\MyApp.sln      # every runnable project it can find
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$Project,

    [string]$Solution,

    [ValidateSet('full', 'nofile', 'off')]
    [string]$Stack = 'full',

    [switch]$RawSql,

    [switch]$Current
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$probe = Join-Path $root 'probe\bin\Release\net8.0\DbProbe.dll'
if (-not (Test-Path $probe)) {
    Write-Host 'Recorder not built yet - building it now...' -ForegroundColor Yellow
    & (Join-Path $root 'build.ps1') -ProbeOnly
}

if ($Solution) {
    if (-not (Test-Path $Solution)) { throw "Solution not found: $Solution" }
    $Project = Get-ChildItem (Split-Path -Parent (Resolve-Path $Solution)) -Recurse -Filter *.csproj |
        Where-Object { Select-String -Path $_.FullName -Pattern 'Microsoft.NET.Sdk.Web' -Quiet } |
        Select-Object -ExpandProperty FullName
    if (-not $Project) { throw "No web projects found under $Solution" }
    Write-Host "Found $($Project.Count) web project(s) in the solution." -ForegroundColor Cyan
}

if (-not $Project) {
    throw 'Give it a .csproj (or -Solution). See: Get-Help .\run-api.ps1 -Examples'
}

$envLines = @(
    "`$env:DOTNET_STARTUP_HOOKS='$probe'"
    "`$env:DBPROBE_STACK='$Stack'"
    "`$env:DBPROBE_RAWSQL='$(if ($RawSql) { 'on' } else { 'off' })'"
)

foreach ($item in $Project) {
    if (-not (Test-Path $item)) { throw "Project not found: $item" }
    $full = (Resolve-Path $item).Path
    $command = ($envLines + "dotnet run --project '$full'") -join '; '

    if ($Current -and $Project.Count -eq 1) {
        Write-Host "Starting $(Split-Path -Leaf $full) with the recorder attached..." -ForegroundColor Cyan
        Invoke-Expression $command
    }
    else {
        Write-Host "Launching $(Split-Path -Leaf $full) in a new window..." -ForegroundColor Cyan
        Start-Process powershell -ArgumentList '-NoExit', '-Command', $command | Out-Null
    }
}

Write-Host ''
Write-Host 'Recorder attached. Open DB Call Overlay to watch.' -ForegroundColor Green
