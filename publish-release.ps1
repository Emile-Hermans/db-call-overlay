<#
.SYNOPSIS
    Builds the setup and publishes it as a GitHub release, which is what the
    app's "Check for updates" looks for in an installed copy.

.DESCRIPTION
    Refuses to publish anything that does not match a pushed commit: the working
    tree must be clean and HEAD must be on GitHub, so every release can be traced
    back to the exact code it was built from.

    Attaches the setup and a .sha256 next to it. The updater only installs a
    download whose SHA-256 it can check.

.PARAMETER Notes
    Markdown for the release page. Lines starting with "- " are what the app
    shows as the list of changes.

.EXAMPLE
    .\publish-release.ps1 -Notes "- Faster waterfall`n- Fix-first list survives a refresh"
#>
param(
    [Parameter(Mandatory)] [string]$Notes,
    [switch]$Draft
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$version = ([xml](Get-Content 'desktop\DbCallOverlay.csproj')).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
$tag = "v$version"

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'The GitHub CLI (gh) is needed: https://cli.github.com' }
if (git status --porcelain) { throw 'There are uncommitted changes. Commit and push them first, so the release matches a commit.' }
git fetch --quiet origin
$head = git rev-parse HEAD
if (-not (git branch -r --contains $head)) { throw 'HEAD is not on GitHub yet. Push it first.' }
# "release not found" on stderr is the expected answer here, and Windows PowerShell
# turns any native stderr into a terminating error under 'Stop'.
$ErrorActionPreference = 'Continue'
& gh release view $tag *> $null
$exists = $LASTEXITCODE -eq 0
$ErrorActionPreference = 'Stop'
if ($exists) { throw "Release $tag already exists. Raise <Version> in desktop\DbCallOverlay.csproj first." }

& (Join-Path $root 'build-installer.ps1')
$setup = Join-Path $root "dist\ClicktraceSetup-$version.exe"
if (-not (Test-Path "$setup.sha256")) { throw "missing $setup.sha256" }

$args = @('release', 'create', $tag, $setup, "$setup.sha256", '--target', $head, '--title', "Clicktrace $version", '--notes', $Notes)
if ($Draft) { $args += '--draft' }
& gh @args
if ($LASTEXITCODE -ne 0) { throw 'gh release create failed' }

Write-Host ''
Write-Host "  Published $tag. Installed copies offer it under Settings -> Check for updates." -ForegroundColor Green
