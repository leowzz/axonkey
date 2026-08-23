$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $repoRoot 'src\Axonkey'
$distRoot = Join-Path $repoRoot 'dist'
$vendorRoot = Join-Path $repoRoot 'vendor\interception'
$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path -LiteralPath $compiler)) {
    throw "The .NET Framework compiler was not found at $compiler"
}

$requiredFiles = @(
    (Join-Path $vendorRoot 'interception.dll'),
    (Join-Path $vendorRoot 'install-interception.exe'),
    (Join-Path $vendorRoot 'LICENSE-LGPL-3.0.txt'),
    (Join-Path $vendorRoot 'SOURCE.md'),
    (Join-Path $repoRoot 'THIRD_PARTY_NOTICES.md')
)

foreach ($path in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required build input is missing: $path"
    }
}

function Get-PeMachine {
    param([Parameter(Mandatory)][string]$Path)

    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
        throw "Not a PE file: $Path"
    }

    $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
    if ($peOffset -lt 0 -or ($peOffset + 6) -gt $bytes.Length) {
        throw "Invalid PE header: $Path"
    }

    return [BitConverter]::ToUInt16($bytes, $peOffset + 4)
}

$interceptionDll = Join-Path $vendorRoot 'interception.dll'
if ((Get-PeMachine -Path $interceptionDll) -ne 0x8664) {
    throw "Axonkey requires the AMD64 build of interception.dll: $interceptionDll"
}

New-Item -ItemType Directory -Force -Path $distRoot | Out-Null
$licenseRoot = Join-Path $distRoot 'licenses'
$driverRoot = Join-Path $distRoot 'driver'
$scriptRoot = Join-Path $distRoot 'scripts'
New-Item -ItemType Directory -Force -Path $licenseRoot, $driverRoot, $scriptRoot | Out-Null
$sources = Get-ChildItem -LiteralPath $sourceRoot -Recurse -Filter '*.cs' |
    Sort-Object FullName |
    ForEach-Object FullName

$arguments = @(
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    '/optimize+',
    '/debug:pdbonly',
    "/win32manifest:$sourceRoot\app.manifest",
    "/out:$distRoot\Axonkey.exe",
    '/reference:System.dll',
    '/reference:System.Core.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll',
    '/reference:System.Windows.Forms.dll'
) + $sources

& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw "Axonkey compilation failed with exit code $LASTEXITCODE" }

Copy-Item -LiteralPath $interceptionDll -Destination (Join-Path $distRoot 'interception.dll') -Force
Copy-Item -LiteralPath (Join-Path $vendorRoot 'install-interception.exe') -Destination $driverRoot -Force
Copy-Item -LiteralPath (Join-Path $vendorRoot 'LICENSE-LGPL-3.0.txt') -Destination $licenseRoot -Force
Copy-Item -LiteralPath (Join-Path $vendorRoot 'SOURCE.md') -Destination (Join-Path $licenseRoot 'Interception-SOURCE.md') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'THIRD_PARTY_NOTICES.md') -Destination $distRoot -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'README.md') -Destination $distRoot -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-driver.ps1') -Destination $scriptRoot -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall-driver.ps1') -Destination $scriptRoot -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-driver.cmd') -Destination $distRoot -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall-driver.cmd') -Destination $distRoot -Force

Write-Host "Built x64 release at $distRoot"
Write-Host 'Driver installation is a separate, explicit administrator action.'
