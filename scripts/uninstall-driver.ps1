[CmdletBinding()]
param(
    [switch]$Elevated,
    [switch]$Confirmed,
    [string]$LogPath
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($LogPath)) {
    $LogPath = Join-Path $env:LOCALAPPDATA 'Axonkey\logs\driver-uninstall.log'
}
$logDirectory = Split-Path -Parent $LogPath
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
if ($Elevated) {
    "Elevated uninstall process started: $(Get-Date -Format o)" | Add-Content -LiteralPath $LogPath -Encoding UTF8
} else {
    "Interception uninstall started: $(Get-Date -Format o)" | Set-Content -LiteralPath $LogPath -Encoding UTF8
}

function Write-DriverLog {
    param([Parameter(Mandatory)][string]$Message)
    "$(Get-Date -Format o) $Message" | Add-Content -LiteralPath $LogPath -Encoding UTF8
}

trap {
    Write-DriverLog "ERROR: $($_ | Out-String)"
    exit 1
}

$scriptRoot = $PSScriptRoot
$scriptPath = $PSCommandPath
if ($scriptRoot.StartsWith('\\?\')) {
    $scriptRoot = $scriptRoot.Substring(4)
}
if ($scriptPath.StartsWith('\\?\')) {
    $scriptPath = $scriptPath.Substring(4)
}
$packageRoot = Split-Path -Parent $scriptRoot
Write-DriverLog "Package root: $packageRoot"
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
Write-DriverLog 'Driver package validation completed.'

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
    Write-DriverLog 'Requesting administrator permission.'
    $arguments = @(
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle', 'Hidden',
        '-ExecutionPolicy', 'Bypass',
        '-File', ('"{0}"' -f $scriptPath),
        '-Elevated',
        '-Confirmed',
        '-LogPath', ('"{0}"' -f $LogPath)
    )
    $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    Write-DriverLog "Elevated process exited with code $($process.ExitCode)."
    exit $process.ExitCode
}

Write-DriverLog "Launching installer: $installer /uninstall"
& $installer /uninstall 2>&1 | Tee-Object -FilePath $LogPath -Append
$exitCode = $LASTEXITCODE
Write-DriverLog "Uninstaller exited with code $exitCode."
if ($exitCode -ne 0) {
    throw "Interception uninstaller failed with exit code $exitCode. Log: $LogPath"
}
Write-DriverLog 'Interception removal completed successfully. Reboot is required.'

Write-Host ''
Write-Host 'Interception was removed. Reboot Windows to finish removal.' -ForegroundColor Green
Write-Host "Log: $LogPath"
