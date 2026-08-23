$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'build.ps1')

function Get-PeMachine {
    param([Parameter(Mandatory)][string]$Path)
    $bytes = [IO.File]::ReadAllBytes($Path)
    $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
    return [BitConverter]::ToUInt16($bytes, $peOffset + 4)
}

$expectedFiles = @(
    'Axonkey.exe',
    'interception.dll',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
    'install-driver.cmd',
    'uninstall-driver.cmd',
    'driver\install-interception.exe',
    'licenses\LICENSE-LGPL-3.0.txt',
    'licenses\Interception-SOURCE.md',
    'scripts\install-driver.ps1',
    'scripts\uninstall-driver.ps1'
)

foreach ($relativePath in $expectedFiles) {
    $path = Join-Path (Join-Path $repoRoot 'dist') $relativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Release file is missing: $relativePath"
    }
}

foreach ($relativePath in @('Axonkey.exe', 'interception.dll')) {
    $path = Join-Path (Join-Path $repoRoot 'dist') $relativePath
    if ((Get-PeMachine -Path $path) -ne 0x8664) {
        throw "Release binary is not AMD64: $relativePath"
    }
}

$expectedDllHash = 'AB88164C11B1B48488772D4C3BFAA4509D5B0AE9DBC5A691DC4F96F0260443C8'
$dllPath = Join-Path $repoRoot 'dist\interception.dll'
if ((Get-FileHash -LiteralPath $dllPath -Algorithm SHA256).Hash -ne $expectedDllHash) {
    throw 'The packaged interception.dll does not match the reviewed v1.0.1 x64 binary.'
}

if (Get-ChildItem -LiteralPath (Join-Path $repoRoot 'dist') -Recurse -File |
        Where-Object Name -Match 'AutoHotkey|AutoHotInterception') {
    throw 'The release unexpectedly contains an AutoHotkey dependency.'
}

$resultPath = Join-Path $env:TEMP 'axonkey-self-test.txt'
Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
$process = Start-Process -FilePath (Join-Path $repoRoot 'dist\Axonkey.exe') `
    -ArgumentList @('--self-test', $resultPath) -Wait -PassThru

if ($process.ExitCode -ne 0) {
    if (Test-Path -LiteralPath $resultPath) { Get-Content -LiteralPath $resultPath }
    throw "Axonkey self-test failed with exit code $($process.ExitCode)"
}

Get-Content -LiteralPath $resultPath
Write-Host 'AXONKEY_PACKAGE_TEST_OK'
