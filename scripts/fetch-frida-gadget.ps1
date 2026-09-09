[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Destination)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$assetName = 'frida-gadget-17.15.3-windows-x86_64.dll.xz'
$expectedHash = 'B566D70189B6D551AD8F4E0BEA24DE08A3D4C0F559BB35B2BDB67D45182240C2'
$cacheDirectory = Join-Path $repoRoot '.build\frida'
$cachePath = Join-Path $cacheDirectory $assetName
New-Item -ItemType Directory -Path $cacheDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $cachePath) -or (Get-FileHash -LiteralPath $cachePath -Algorithm SHA256).Hash -ne $expectedHash) {
    $downloadPath = $cachePath + '.download'
    Write-Output 'Downloading pinned Frida Gadget 17.15.3 from its official release...'
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/frida/frida/releases/download/17.15.3/$assetName" -OutFile $downloadPath -TimeoutSec 60
    if ((Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Frida Gadget archive hash mismatch; refusing to use it.' }
    Move-Item -LiteralPath $downloadPath -Destination $cachePath -Force
}
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
Copy-Item -LiteralPath $cachePath -Destination (Join-Path $Destination $assetName) -Force
Write-Output 'Frida Gadget archive verified. No driver was installed.'
