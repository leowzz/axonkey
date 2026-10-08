# Build only. This script never runs the resulting service or its installer.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Build this service on Windows x64 with Visual Studio 2022 C++ tools and CMake.' }
# PowerShell 7 CI can pass its PSModulePath to this Windows PowerShell 5.1
# child. Load this host's built-in utility module explicitly for hashing/JSON.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$root = Split-Path -Parent $PSScriptRoot
$revision = '2750401336fb7c95f6619657a46a7e798661341c'
$work = Join-Path $root '.build\interception-fix'
$vcpkg = Join-Path $work 'vcpkg'
$source = Join-Path $work 'source'
$build = Join-Path $work 'build'
$output = Join-Path $root 'vendor\interception-fix'
function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed: $LASTEXITCODE" }
}
$cmake = Get-Command cmake -ErrorAction SilentlyContinue
if ($cmake) {
    $cmakePath = $cmake.Source
} else {
    # Visual Studio may provide CMake without adding it to the user's PATH.
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vsRoot = if (Test-Path -LiteralPath $vswhere) { & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath }
    if (-not $vsRoot) { throw 'CMake >= 3.24 is required. Install CMake or the Visual Studio C++ CMake tools.' }
    $cmakePath = Join-Path $vsRoot 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
    if (-not (Test-Path -LiteralPath $cmakePath)) { throw 'CMake >= 3.24 is required. Install CMake or the Visual Studio C++ CMake tools.' }
}
Invoke-Checked 'node' @((Join-Path $PSScriptRoot 'verify-interception-fix.mjs'), '--source-only')
New-Item -ItemType Directory -Force $work, $source, $output | Out-Null
if (-not (Test-Path (Join-Path $vcpkg '.git'))) {
    Invoke-Checked 'git' @('clone', '--no-checkout', 'https://github.com/microsoft/vcpkg.git', $vcpkg)
}
Invoke-Checked 'git' @('-C', $vcpkg, 'checkout', '--detach', $revision)
$actual = & git -C $vcpkg rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $actual -ne $revision) { throw 'vcpkg revision mismatch' }
$dirty = & git -C $vcpkg status --porcelain --untracked-files=no
if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'vcpkg has local source changes; use a clean build directory.' }
Invoke-Checked (Join-Path $vcpkg 'bootstrap-vcpkg.bat') @('-disableMetrics')
Copy-Item -Path (Join-Path $root 'third_party\interception-driver-fix\*') -Destination $source -Recurse -Force
Copy-Item (Join-Path $source 'Axonkey.CMakeLists.txt') (Join-Path $source 'CMakeLists.txt') -Force
Invoke-Checked $cmakePath @('-S', $source, '-B', $build, '-G', 'Visual Studio 17 2022', '-A', 'x64', "-DCMAKE_TOOLCHAIN_FILE=$vcpkg/scripts/buildsystems/vcpkg.cmake", '-DVCPKG_TARGET_TRIPLET=x64-windows-static', '-DVCPKG_HOST_TRIPLET=x64-windows-static')
Invoke-Checked $cmakePath @('--build', $build, '--config', 'Release', '--target', 'axonkey-interception-fix', '--parallel')
Copy-Item (Join-Path $build 'Release\axonkey-interception-fix.exe') $output -Force
$licenses = Join-Path $output 'licenses'
New-Item -ItemType Directory -Force $licenses | Out-Null
Copy-Item (Join-Path $source 'LICENSE') (Join-Path $licenses 'interception-driver-fix.txt') -Force
Copy-Item (Join-Path $source 'vendor\include\sr\detail\scope_guard_base.h') (Join-Path $licenses 'scope-guard-MIT.txt') -Force
$share = Join-Path $build 'vcpkg_installed\x64-windows-static\share'
foreach ($name in @('cli11', 'fmt', 'spdlog', 'boost-algorithm', 'phnt')) {
    if (-not (Test-Path (Join-Path $share "$name\copyright"))) { throw "Missing dependency license: $name" }
}
Get-ChildItem -Path $share -Filter copyright -Recurse | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $licenses ($_.Directory.Name + '.txt')) -Force
}
$files = @('axonkey-interception-fix.exe') + @(Get-ChildItem $licenses -File | ForEach-Object { 'licenses/' + $_.Name })
$hashes = [ordered]@{}
foreach ($file in $files) { $hashes[$file] = (Get-FileHash (Join-Path $output $file) -Algorithm SHA256).Hash.ToLowerInvariant() }
[ordered]@{ upstreamCommit = 'e1a7720863f514d51caf06b020da5c0d2e345c41'; vcpkgCommit = $revision; files = $hashes } | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $output 'manifest.json') -Encoding ascii
Invoke-Checked 'node' @((Join-Path $PSScriptRoot 'verify-interception-fix.mjs'), '--artifact')
