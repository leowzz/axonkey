[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('install', 'uninstall')]
    [string]$Action,
    [switch]$Elevated,
    [switch]$Confirmed,
    [string]$LogPath
)

$ErrorActionPreference = 'Stop'
$packageVersion = 'Pack45'
$archiveName = 'VBCABLE_Driver_Pack45.zip'
$expectedArchiveHash = 'B950E39F01AF1D04EA623C8F6D8EB9B6EA5C477C637295FABF20631C85116BFB'
$expectedInstallerHash = '734C35DFA6D98F48782A451633CEB471166EC70D60482FD89A1123D0EE3C4F41'
$servicePath = 'HKLM:\SYSTEM\CurrentControlSet\Services\VBAudioVACMME'

if ([string]::IsNullOrWhiteSpace($LogPath)) {
    $LogPath = Join-Path $env:LOCALAPPDATA "Axonkey\logs\vbcable-$Action.log"
}
$logDirectory = Split-Path -Parent $LogPath
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
if ($Elevated) {
    "Elevated VB-CABLE $Action process started: $(Get-Date -Format o)" | Add-Content -LiteralPath $LogPath -Encoding UTF8
} else {
    "VB-CABLE $Action started: $(Get-Date -Format o)" | Set-Content -LiteralPath $LogPath -Encoding UTF8
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
$archiveCandidates = @(
    (Join-Path $packageRoot "vendor\vbcable\$archiveName"),
    (Join-Path $packageRoot "vbcable\$archiveName")
)
$archive = $archiveCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $archive) {
    throw "The reviewed VB-CABLE package was not found. Checked: $($archiveCandidates -join ', ')"
}

$actualArchiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
if ($actualArchiveHash -ne $expectedArchiveHash) {
    throw "VB-CABLE package hash mismatch. Refusing to run an unreviewed driver package: $archive"
}
Write-DriverLog "VB-CABLE $packageVersion package validation completed."

if (-not $Confirmed) {
    Write-Host 'Axonkey uses VB-Audio VB-CABLE as its virtual microphone device.' -ForegroundColor Yellow
    Write-Host 'VB-CABLE is Donationware from https://vb-audio.com/Cable/.'
    Write-Host 'The official installer requires administrator permission and a Windows reboot.'
    Write-Host "Package: $archive"
    Write-Host "SHA-256: $actualArchiveHash"
    $expectedAnswer = if ($Action -eq 'install') { 'INSTALL' } else { 'UNINSTALL' }
    $answer = Read-Host "Type $expectedAnswer to continue"
    if ($answer -cne $expectedAnswer) {
        Write-Host 'Operation cancelled. No system changes were made.'
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
        '-ExecutionPolicy', 'Bypass',
        '-File', ('"{0}"' -f $scriptPath),
        '-Action', $Action,
        '-Elevated',
        '-Confirmed',
        '-LogPath', ('"{0}"' -f $LogPath)
    )
    $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments -Wait -PassThru
    Write-DriverLog "Elevated process exited with code $($process.ExitCode)."
    exit $process.ExitCode
}

if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'Axonkey supports only 64-bit Windows.'
}

$currentlyInstalled = Test-Path -LiteralPath $servicePath
if ($Action -eq 'install' -and $currentlyInstalled) {
    Write-DriverLog 'VB-CABLE is already installed.'
    exit 0
}
if ($Action -eq 'uninstall' -and -not $currentlyInstalled) {
    Write-DriverLog 'VB-CABLE is already absent.'
    exit 0
}

$extractRoot = Join-Path ([IO.Path]::GetTempPath()) ("Axonkey\VBCABLE_$([Guid]::NewGuid().ToString('N'))")
try {
    New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $extractRoot
    $installer = Join-Path $extractRoot 'VBCABLE_Setup_x64.exe'
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
        throw "The official x64 installer is missing from $archive"
    }

    $actualInstallerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
    if ($actualInstallerHash -ne $expectedInstallerHash) {
        throw 'The extracted VB-CABLE installer does not match the reviewed Pack45 binary.'
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
        $signature.SignerCertificate.Subject -notmatch 'BUREL VINCENT|Vincent Burel') {
        throw "VB-CABLE installer signature validation failed: $($signature.Status)"
    }

    Write-DriverLog "Launching the official VB-CABLE installer for $Action."
    $process = Start-Process -FilePath $installer -WorkingDirectory $extractRoot -Wait -PassThru
    Write-DriverLog "Official installer exited with code $($process.ExitCode)."
    if ($process.ExitCode -ne 0) {
        throw "VB-CABLE installer failed with exit code $($process.ExitCode). Log: $LogPath"
    }

    $installedAfterAction = Test-Path -LiteralPath $servicePath
    if ($Action -eq 'install' -and -not $installedAfterAction) {
        throw 'VB-CABLE was not detected after the installer closed. The installation may have been cancelled.'
    }
    if ($Action -eq 'uninstall' -and $installedAfterAction) {
        throw 'VB-CABLE is still registered after the installer closed. The removal may have been cancelled.'
    }

    Write-DriverLog "VB-CABLE $Action completed successfully. Reboot is required."
} finally {
    if (Test-Path -LiteralPath $extractRoot) {
        Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
Write-Host "VB-CABLE $Action completed. Reboot Windows to finish the operation." -ForegroundColor Green
Write-Host "Log: $LogPath"
