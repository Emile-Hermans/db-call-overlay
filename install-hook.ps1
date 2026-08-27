<#
.SYNOPSIS
    Attaches the probe to every .NET app you start, permanently, for your user account.

.DESCRIPTION
    Use this if you do not want to launch Visual Studio through start-vs.ps1 every time.
    It sets DOTNET_STARTUP_HOOKS as a user environment variable, so Visual Studio,
    `dotnet run` and anything else picks it up automatically after a restart.

    The DBPROBE_APPS filter means the probe only activates inside WebApi.* processes;
    everywhere else it returns immediately.

    Trade-off, and it is a real one: while this is installed, every dotnet process on
    the machine loads DbProbe.dll at startup. If that file is ever moved or deleted,
    dotnet commands will fail to start until you run .\install-hook.ps1 -Remove.
    Do not delete the DbCallOverlay folder while this is installed.

.EXAMPLE
    .\install-hook.ps1
    .\install-hook.ps1 -Remove
#>
[CmdletBinding()]
param(
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$names = 'DOTNET_STARTUP_HOOKS', 'DBPROBE_APPS'

if ($Remove) {
    foreach ($name in $names) {
        [Environment]::SetEnvironmentVariable($name, $null, 'User')
        Write-Host "removed $name" -ForegroundColor Green
    }
    Write-Host ''
    Write-Host 'Restart Visual Studio (and any terminals) for this to take effect.'
    return
}

$probe = Join-Path $root 'probe\bin\Release\net8.0\DbProbe.dll'
if (-not (Test-Path $probe)) {
    Write-Host 'Probe not built yet - building it now...' -ForegroundColor Yellow
    & (Join-Path $root 'build.ps1') -ProbeOnly
}

$existing = [Environment]::GetEnvironmentVariable('DOTNET_STARTUP_HOOKS', 'User')
if ($existing -and $existing -ne $probe) {
    Write-Warning "DOTNET_STARTUP_HOOKS is already set to: $existing"
    Write-Warning 'It will be replaced. Note it down if you need it back.'
}

[Environment]::SetEnvironmentVariable('DOTNET_STARTUP_HOOKS', $probe, 'User')
[Environment]::SetEnvironmentVariable('DBPROBE_APPS', 'WebApi.', 'User')

Write-Host "DOTNET_STARTUP_HOOKS = $probe" -ForegroundColor Green
Write-Host "DBPROBE_APPS         = WebApi." -ForegroundColor Green
Write-Host ''
Write-Host 'Now close Visual Studio and open it again - it only reads the environment at startup.'
Write-Host 'Undo any time with:  .\install-hook.ps1 -Remove'
