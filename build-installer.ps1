<#
.SYNOPSIS
    Builds dist\ClicktraceSetup-<version>.exe: one file someone can download and
    run, without cloning the repository or installing .NET or Node.js.

.DESCRIPTION
    The setup carries everything the app needs:
      app\             the desktop app, published self-contained (its own .NET runtime)
      app\server, ui   the collector and the page, as in a normal build
      app\probe        the recorder, built fresh
      app\node         the official Node.js for Windows x64, checksum-verified
      app\extension    the optional browser extension, for "Load unpacked"

    The setup exe itself targets .NET Framework 4.8, which every Windows 10 and
    11 already has. It installs for the current user, so it never needs admin.

    Needs: the .NET SDK, and internet access the first time (to fetch Node.js;
    it is cached in dist\cache after that).

.PARAMETER NodeVersion
    The Node.js version to bundle. Defaults to the one on this machine.
#>
param(
    [string]$NodeVersion,
    # Overrides the version in desktop\DbCallOverlay.csproj - for testing an update.
    [string]$Version
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'stage'
$app = Join-Path $stage 'app'
$cache = Join-Path $dist 'cache'

function Step($text) { Write-Host "-> $text" -ForegroundColor Cyan }

$version = if ($Version) { $Version } else { ([xml](Get-Content (Join-Path $root 'desktop\DbCallOverlay.csproj'))).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1 }
if (-not $version) { throw 'No <Version> in desktop\DbCallOverlay.csproj' }

if (-not $NodeVersion) { $NodeVersion = (& node --version).TrimStart('v') }
$NodeVersion = $NodeVersion.TrimStart('v')

Write-Host ''
Write-Host "  Clicktrace $version setup  (bundling Node.js $NodeVersion)" -ForegroundColor Cyan
Write-Host ''

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $app, $cache | Out-Null

# ---------------------------------------------------------------- recorder
# Built into its own folder: the one in probe\bin is locked while recording is
# switched on, because every .NET process on the machine has it loaded.
Step 'Building the recorder'
& dotnet build (Join-Path $root 'probe\DbProbe.csproj') -c Release --nologo -v quiet -o (Join-Path $stage 'probe-build')
if ($LASTEXITCODE -ne 0) { throw 'recorder build failed' }

# ---------------------------------------------------------------- app
Step 'Publishing the app with its own .NET runtime'
& dotnet publish (Join-Path $root 'desktop\DbCallOverlay.csproj') -c Release -r win-x64 --self-contained true --nologo -v quiet -o $app "-p:Version=$version" 
if ($LASTEXITCODE -ne 0) { throw 'app publish failed' }
foreach ($required in 'DbCallOverlay.exe', 'server\index.mjs', 'ui\index.html') {
    if (-not (Test-Path (Join-Path $app $required))) { throw "publish is missing $required" }
}

New-Item -ItemType Directory -Force (Join-Path $app 'probe') | Out-Null
Copy-Item (Join-Path $stage 'probe-build\DbProbe.dll') (Join-Path $app 'probe') -Force
Copy-Item (Join-Path $stage 'probe-build\DbProbe.pdb') (Join-Path $app 'probe') -Force -ErrorAction SilentlyContinue

# ---------------------------------------------------------------- node
Step "Fetching Node.js $NodeVersion"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$nodeExe = Join-Path $cache "node-v$NodeVersion-win-x64.exe"
$nodeLicense = Join-Path $cache "node-v$NodeVersion-LICENSE"
$base = "https://nodejs.org/dist/v$NodeVersion"

$sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content
$expected = ($sums -split "`n" | Where-Object { $_ -match '\swin-x64/node\.exe$' } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
if (-not $expected) { throw "Node.js $NodeVersion has no win-x64/node.exe in its SHASUMS256.txt" }

if (-not (Test-Path $nodeExe) -or (Get-FileHash $nodeExe -Algorithm SHA256).Hash -ne $expected.ToUpper()) {
    Invoke-WebRequest "$base/win-x64/node.exe" -OutFile $nodeExe -UseBasicParsing
}
$actual = (Get-FileHash $nodeExe -Algorithm SHA256).Hash
if ($actual -ne $expected.ToUpper()) {
    Remove-Item $nodeExe -Force
    throw "node.exe checksum mismatch: expected $expected, got $actual"
}
if (-not (Test-Path $nodeLicense)) {
    Invoke-WebRequest "https://raw.githubusercontent.com/nodejs/node/v$NodeVersion/LICENSE" -OutFile $nodeLicense -UseBasicParsing
}
New-Item -ItemType Directory -Force (Join-Path $app 'node') | Out-Null
Copy-Item $nodeExe (Join-Path $app 'node\node.exe') -Force
Copy-Item $nodeLicense (Join-Path $app 'node\LICENSE') -Force

# ---------------------------------------------------------------- the rest
Step 'Adding the browser extension and licence'
Copy-Item (Join-Path $root 'extension') (Join-Path $app 'extension') -Recurse -Force
Copy-Item (Join-Path $root 'LICENSE') (Join-Path $app 'LICENSE') -Force
@"
Clicktrace $version

Open Clicktrace from the Start menu and press "Switch recording on".
Then start your .NET API and click around in your app.

Optional browser extension (names each flow after the button you clicked):
  chrome://extensions or edge://extensions -> Developer mode -> Load unpacked ->
  the "extension" folder next to DbCallOverlay.exe

Recordings and settings: %LOCALAPPDATA%\DbCallOverlay
Remove it from Settings -> Apps -> Installed apps -> Clicktrace.

Bundled: Node.js $NodeVersion (MIT, see node\LICENSE) and the .NET runtime (MIT).
"@ | Set-Content (Join-Path $app 'README.txt') -Encoding UTF8

# ---------------------------------------------------------------- payload + setup
Step 'Compressing'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$payload = Join-Path $stage 'payload.zip'
[IO.Compression.ZipFile]::CreateFromDirectory($app, $payload, [IO.Compression.CompressionLevel]::Optimal, $false)

Step 'Building the setup'
& dotnet build (Join-Path $root 'installer\ClicktraceSetup.csproj') -c Release --nologo -v quiet `
    "-p:Version=$version" "-p:PayloadZip=$payload" -o (Join-Path $stage 'setup-build')
if ($LASTEXITCODE -ne 0) { throw 'setup build failed' }

$out = Join-Path $dist "ClicktraceSetup-$version.exe"
Copy-Item (Join-Path $stage 'setup-build\ClicktraceSetup.exe') $out -Force

$size = '{0:N0} MB' -f ((Get-Item $out).Length / 1MB)
$hash = (Get-FileHash $out -Algorithm SHA256).Hash
# Published next to the setup: the app's updater refuses a download it cannot check.
"$($hash.ToLower())  $(Split-Path -Leaf $out)" | Set-Content "$out.sha256" -Encoding ASCII -NoNewline
Write-Host ''
Write-Host "  $out" -ForegroundColor Green
Write-Host "  $size  sha256 $hash"
Write-Host ''
Write-Host '  Not code-signed: Windows SmartScreen will say "Windows protected your PC".'
Write-Host '  The person installing clicks "More info" -> "Run anyway".'
Write-Host ''
