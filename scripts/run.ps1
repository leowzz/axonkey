$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$app = Join-Path $repoRoot 'dist\Axonkey.exe'

if (-not (Test-Path -LiteralPath $app)) {
    & (Join-Path $PSScriptRoot 'build.ps1')
}

$nativeLibrary = Join-Path $repoRoot 'dist\interception.dll'
if (-not (Test-Path -LiteralPath $nativeLibrary -PathType Leaf)) {
    throw "Interception runtime is missing: $nativeLibrary. Run scripts\build.ps1 again."
}

Start-Process -FilePath $app
