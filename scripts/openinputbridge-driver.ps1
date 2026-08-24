[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Install', 'Uninstall')]
    [string]$Action,
    [switch]$Elevated,
    [switch]$Confirmed,
    [string]$LogPath
)

$ErrorActionPreference = 'Stop'
$actionName = $Action.ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($LogPath)) {
    $LogPath = Join-Path $env:LOCALAPPDATA "Axonkey\logs\driver-$actionName.log"
}
$logDirectory = Split-Path -Parent $LogPath
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
if ($Elevated) {
    "Elevated OpenInputBridge $actionName process started: $(Get-Date -Format o)" | Add-Content -LiteralPath $LogPath -Encoding UTF8
} else {
    "OpenInputBridge $actionName started: $(Get-Date -Format o)" | Set-Content -LiteralPath $LogPath -Encoding UTF8
}

function Write-DriverLog {
    param([Parameter(Mandatory)][string]$Message)
    "$(Get-Date -Format o) $Message" | Add-Content -LiteralPath $LogPath -Encoding UTF8
}

function Assert-ValidSignature {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$PublisherPattern
    )
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "Invalid Authenticode signature for ${Path}: $($signature.StatusMessage)"
    }
    $subject = $signature.SignerCertificate.Subject
    if ($subject -notlike $PublisherPattern) {
        throw "Unexpected signer for ${Path}: $subject"
    }
    Write-DriverLog "Validated signature: $Path [$subject]"
}

function Invoke-OibInstaller {
    param([string[]]$Arguments)
    $displayArguments = if ($Arguments.Count -eq 0) { '<none>' } else { $Arguments -join ' ' }
    Write-DriverLog "Launching installer: $installer $displayArguments"
    & $installer @Arguments 2>&1 | Tee-Object -FilePath $LogPath -Append
    $exitCode = $LASTEXITCODE
    Write-DriverLog "Installer exited with code $exitCode."
    if ($exitCode -ne 0) {
        throw "OpenInputBridge installer failed with exit code $exitCode. Log: $LogPath"
    }
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
    (Join-Path $packageRoot 'vendor\openinputbridge\OpenInputBridgeSetup.exe'),
    (Join-Path $packageRoot 'driver\openinputbridge\OpenInputBridgeSetup.exe')
)
$installer = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $installer) {
    throw "OpenInputBridge WHQL installer was not found. Checked: $($candidates -join ', ')"
}

if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'Axonkey supports only 64-bit Windows.'
}

$oibRoot = Split-Path -Parent $installer
$requiredFiles = @(
    'oib_kbd\oib_kbd.inf',
    'oib_kbd\oib_kbd.cat',
    'oib_kbd\oib_kbd.sys',
    'oib_mou\oib_mou.inf',
    'oib_mou\oib_mou.cat',
    'oib_mou\oib_mou.sys'
)
foreach ($relativePath in $requiredFiles) {
    $path = Join-Path $oibRoot $relativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "OpenInputBridge package is incomplete: $path"
    }
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    Write-DriverLog "Package file: $relativePath SHA256=$hash"
}

Assert-ValidSignature -Path $installer -PublisherPattern '*Applet LLC*'
Assert-ValidSignature -Path (Join-Path $oibRoot 'oib_kbd\oib_kbd.cat') -PublisherPattern '*Microsoft Windows Hardware Compatibility Publisher*'
Assert-ValidSignature -Path (Join-Path $oibRoot 'oib_mou\oib_mou.cat') -PublisherPattern '*Microsoft Windows Hardware Compatibility Publisher*'

if ($Action -eq 'Install') {
    $legacyDrivers = @(
        (Join-Path $env:WINDIR 'System32\drivers\keyboard.sys'),
        (Join-Path $env:WINDIR 'System32\drivers\mouse.sys')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
    if ($legacyDrivers.Count -gt 0) {
        throw "Legacy Interception is still installed ($($legacyDrivers -join ', ')). Uninstall it with its official installer, reboot Windows, then install OpenInputBridge."
    }
}

if (-not $Confirmed) {
    if ($Action -eq 'Install') {
        Write-Host 'Axonkey will install the signed OpenInputBridge keyboard and mouse filter drivers.' -ForegroundColor Yellow
        Write-Host 'This changes the Windows input stack, enables the OIB access audit/toast, and requires one reboot.'
        $confirmation = 'INSTALL'
    } else {
        Write-Host 'Axonkey will remove the OpenInputBridge keyboard and mouse filter drivers.' -ForegroundColor Yellow
        Write-Host 'Axonkey and every other OpenInputBridge client must be closed first. Windows must be rebooted afterward.'
        $confirmation = 'UNINSTALL'
    }
    Write-Host "Installer: $installer"
    $answer = Read-Host "Type $confirmation to continue"
    if ($answer -cne $confirmation) {
        Write-Host "$Action cancelled. No system changes were made."
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
        '-Action', $Action,
        '-Elevated',
        '-Confirmed',
        '-LogPath', ('"{0}"' -f $LogPath)
    )
    $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    Write-DriverLog "Elevated process exited with code $($process.ExitCode)."
    exit $process.ExitCode
}

if ($Action -eq 'Install') {
    Invoke-OibInstaller -Arguments @()
    Invoke-OibInstaller -Arguments @('--enable-audit-log')
    Invoke-OibInstaller -Arguments @('--enable-toast')
    Invoke-OibInstaller -Arguments @('--verify-install')
    Write-DriverLog 'OpenInputBridge installation completed successfully. Reboot is required.'
    Write-Host ''
    Write-Host 'OpenInputBridge was installed. Reboot Windows before starting Axonkey.' -ForegroundColor Green
} else {
    Invoke-OibInstaller -Arguments @('--disable-toast')
    Invoke-OibInstaller -Arguments @('--disable-audit-log')
    Invoke-OibInstaller -Arguments @('/uninstall')
    Write-DriverLog 'OpenInputBridge removal completed successfully. Reboot is required.'
    Write-Host ''
    Write-Host 'OpenInputBridge was removed. Reboot Windows to finish removal.' -ForegroundColor Green
}
Write-Host 'Later mapping changes do not require a reboot.'
Write-Host "Log: $LogPath"
