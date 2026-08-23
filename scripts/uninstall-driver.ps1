[CmdletBinding()]
param(
    [switch]$Elevated,
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
$candidates = @(
    (Join-Path $packageRoot 'vendor\interception\install-interception.exe'),
    (Join-Path $packageRoot 'driver\install-interception.exe')
)
$installer = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $installer) {
    throw "Interception installer was not found. Checked: $($candidates -join ', ')"
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

if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'Axonkey supports only 64-bit Windows.'
}
if ((Get-PeMachine -Path $installer) -ne 0x014C) {
    throw "Unexpected installer architecture (expected the reviewed x86 bootstrapper): $installer"
}

$expectedHash = 'E137863A79DA797F08E7A137280FF2A123809044A888FD75CE9C973198915ABE'
$actualHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) {
    throw "Installer hash mismatch. Refusing to run an unreviewed driver package: $installer"
}

if (-not $Confirmed) {
    Write-Host 'This removes the Interception filter driver used by Axonkey.' -ForegroundColor Yellow
    Write-Host 'Axonkey and every other Interception-based input tool must be closed first.'
    Write-Host 'Windows must be rebooted after removal.'
    Write-Host "Installer: $installer"
    $answer = Read-Host 'Type UNINSTALL to continue'
    if ($answer -cne 'UNINSTALL') {
        Write-Host 'Removal cancelled. No system changes were made.'
        exit 2
    }
    $Confirmed = $true
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    $arguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', ('"{0}"' -f $PSCommandPath),
        '-Elevated',
        '-Confirmed'
    )
    $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    exit $process.ExitCode
}

$logPath = Join-Path $env:TEMP ('axonkey-interception-uninstall-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
"Interception uninstall started: $(Get-Date -Format o)" | Set-Content -LiteralPath $logPath -Encoding Unicode
& $installer /uninstall 2>&1 | Tee-Object -FilePath $logPath -Append
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    throw "Interception uninstaller failed with exit code $exitCode. Log: $logPath"
}

Write-Host ''
Write-Host 'Interception was removed. Reboot Windows to finish removal.' -ForegroundColor Green
Write-Host "Log: $logPath"
