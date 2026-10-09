[CmdletBinding()]
param(
    [ValidateSet('status', 'install', 'uninstall')][string]$Action = 'status',
    [switch]$Confirmed
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitProcess) { throw 'Requires 64-bit Windows PowerShell.' }
$serviceName = 'AxonkeyInterceptionFix'
function Convert-ToProviderPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'A required Windows path is empty.' }
    if ($Path.StartsWith('\\?\') -and $Path.Length -gt 6 -and $Path[5] -eq ':') {
        return $Path.Substring(4)
    }
    return $Path
}
$scriptRoot = Convert-ToProviderPath $PSScriptRoot
# Tauri can launch a bundled resource through the Win32 extended path form
# (\\?\C:\...). PowerShell's file-system provider does not consistently
# resolve that form as a provider drive, which can surface as a null `drive`
# argument while validating package paths. Keep normal drive paths for all
# provider operations; preserve extended UNC paths.
$programFiles = [Environment]::GetFolderPath('ProgramFiles')
$programData = [Environment]::GetFolderPath('CommonApplicationData')
$installDir = Join-Path $programFiles 'Axonkey Interception Fix'
$dataDir = Join-Path $programData 'Axonkey Interception Fix'
$exePath = Join-Path $installDir 'axonkey-interception-fix.exe'
$binaryPath = '"' + $exePath + '"'
$iniPath = Join-Path $dataDir 'interception-driver-fix.ini'
$sc = Join-Path $env:SystemRoot 'System32\sc.exe'

function Get-FixService {
    Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
}
function Assert-OwnedService($Service) {
    if ($Service -and ($Service.PathName -cne $binaryPath -or $Service.StartName -ne 'LocalSystem')) {
        throw 'An unexpected service uses the Axonkey name. Refusing to overwrite or remove it.'
    }
}
function Assert-InterceptionDrivers {
    # The Interception installer can omit the registry ImagePath value. Ask
    # Windows for the resolved driver path instead of requiring that value.
    foreach ($driver in @('keyboard', 'mouse')) {
        $service = Get-CimInstance Win32_SystemDriver -Filter "Name='$driver'"
        if (-not $service -or $service.PathName -notmatch "(?i)(^|[\\/])$driver\.sys$") {
            throw 'Install the Interception input driver and restart Windows first.'
        }
    }
}
function Assert-NoReparse([string]$Path) {
    $item = $Path
    while ($item) {
        if (Test-Path -LiteralPath $item) {
            if ((Get-Item -LiteralPath $item -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing a redirected path: $item" }
        }
        $item = Split-Path -Parent $item
    }
}
function Invoke-ServiceControl([string[]]$Arguments) {
    $result = & $sc @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Service control failed ($LASTEXITCODE): $result" }
}
function Protect-Directory([string]$Path) {
    Assert-NoReparse $Path
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    # This protects our own service/config files, never Interception device ACLs.
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)')
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Protect-File([string]$Path) {
    Assert-NoReparse $Path
    if (Test-Path -LiteralPath $Path) {
        $acl = New-Object Security.AccessControl.FileSecurity
        $acl.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;BU)')
        Set-Acl -LiteralPath $Path -AclObject $acl
    }
}
function Assert-Package([string]$Directory) {
    $manifest = Get-Content -LiteralPath (Join-Path $Directory 'manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.upstreamCommit -ne 'e1a7720863f514d51caf06b020da5c0d2e345c41' -or $manifest.vcpkgCommit -ne '2750401336fb7c95f6619657a46a7e798661341c') { throw 'Unexpected service provenance. Rebuild the pinned package.' }
    foreach ($required in @('axonkey-interception-fix.exe', 'licenses/interception-driver-fix.txt', 'licenses/scope-guard-MIT.txt', 'licenses/cli11.txt', 'licenses/fmt.txt', 'licenses/spdlog.txt', 'licenses/boost-algorithm.txt', 'licenses/phnt.txt')) {
        if (-not $manifest.files.PSObject.Properties[$required]) { throw "Missing package file: $required" }
    }
    foreach ($entry in $manifest.files.PSObject.Properties) {
        if ($entry.Name -notmatch '^[\w./-]+$' -or $entry.Name.StartsWith('/') -or $entry.Name.Split('/') -contains '..' -or $entry.Value -notmatch '^[a-f0-9]{64}$') { throw 'Invalid package manifest' }
        $file = Join-Path $Directory $entry.Name
        Assert-NoReparse $file
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.Value) { throw "Package SHA-256 mismatch: $($entry.Name)" }
    }
    $bytes = [IO.File]::ReadAllBytes((Join-Path $Directory 'axonkey-interception-fix.exe'))
    if ($bytes.Length -lt 64) { throw 'Invalid service executable' }
    $offset = [BitConverter]::ToUInt32($bytes, 0x3c)
    if ($offset + 6 -gt $bytes.Length -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a -or [BitConverter]::ToUInt32($bytes, $offset) -ne 0x4550 -or [BitConverter]::ToUInt16($bytes, $offset + 4) -ne 0x8664) { throw 'Expected an AMD64 PE service' }
    return $manifest
}

if ($Action -eq 'status') {
    $service = Get-FixService
    Assert-OwnedService $service
    $pending = $false
    $configured = $false
    if ($service) {
        $ini = Get-Content -LiteralPath $iniPath -Raw
        $configured = $ini -match '(?m)^lockdown=no\r?$' -and $service.StartMode -eq 'Auto'
        $installedAt = [DateTime]::Parse((Get-Content -LiteralPath (Join-Path $dataDir 'installed-at.txt') -Raw)).ToUniversalTime()
        $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()
        $pending = $installedAt -gt $boot
    }
    [ordered]@{ installed = [bool]$service; configured = $configured; restartRequired = $pending; serviceState = $(if ($service) { $service.State } else { 'Absent' }); exitCode = $(if ($service) { $service.ExitCode } else { 0 }) } | ConvertTo-Json -Compress
    exit 0
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    Protect-Directory $dataDir
    Protect-Directory (Join-Path $dataDir 'logs')
    $LogPath = Join-Path $dataDir "logs\manage-$Action.log"
    Protect-File $LogPath
} else {
    $LogPath = Join-Path $env:LOCALAPPDATA "Axonkey\logs\interception-fix-$Action.log"
    New-Item -ItemType Directory -Force (Split-Path -Parent $LogPath) | Out-Null
}
function Write-FixLog([string]$Message) { "$(Get-Date -Format o) $Message" | Add-Content -LiteralPath $LogPath -Encoding UTF8 }
trap { Write-FixLog "ERROR: $_"; Write-Error -ErrorAction Continue "$_ Log: $LogPath"; exit 1 }
if (-not $Confirmed) {
    Write-Host 'Reconnect compatibility service: installs/removes a system-wide boot service. Restart Windows afterwards.'
    Write-Host 'Uses lockdown=no. It does not restore old ACLs or immediately undo existing links.'
    if ((Read-Host "Type $($Action.ToUpperInvariant()) to continue") -cne $Action.ToUpperInvariant()) { exit 2 }
}
if (-not $isAdmin) {
    $scriptPath = Convert-ToProviderPath $PSCommandPath
    if ($scriptPath.Contains('"')) { throw 'Invalid path' }
    $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $scriptPath), '-Action', $Action, '-Confirmed')
    $process = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments -Wait -PassThru
    Write-FixLog "Elevated process exited: $($process.ExitCode)"
    exit $process.ExitCode
}

# Serializes commands from multiple app instances; no background polling/repair loop.
$mutex = New-Object Threading.Mutex($false, 'Global\AxonkeyInterceptionFixSetup')
if (-not $mutex.WaitOne(0)) { throw 'Another reconnect-fix operation is in progress.' }
try {
    $service = Get-FixService
    Assert-OwnedService $service
    Assert-NoReparse $installDir
    Assert-NoReparse $dataDir
    if ($Action -eq 'uninstall') {
        if ($service) {
            Invoke-ServiceControl @('config', $serviceName, 'start=', 'disabled')
            # The one-shot service accepts no STOP. Wait for completion, then delete.
            $deadline = (Get-Date).AddSeconds(30)
            while ((Get-FixService).State -ne 'Stopped') {
                if ((Get-Date) -gt $deadline) { throw 'Service disabled but still running. Restart Windows, then retry removal.' }
                Start-Sleep -Milliseconds 250
            }
            Invoke-ServiceControl @('delete', $serviceName)
        }
        # Keep the protected payload, licenses, and recovery script for diagnosis.
        # No recursive deletion of shared/system paths; no device ACL or link edits.
        Write-FixLog 'Service removed (or already absent). Payload retained; restart Windows to clear boot-lifetime links.'
        Write-Host "Service removed. Restart Windows. Files retained in $installDir and $dataDir."
        exit 0
    }
    if (Get-CimInstance Win32_Service -Filter "Name='InterceptionDriverFix'") { throw 'The upstream InterceptionDriverFix service is installed. Remove it with its own uninstaller and restart Windows first.' }
    if ($service) { throw 'Already installed. Remove the reconnect fix, restart Windows, then enable again to replace it.' }
    $root = Split-Path -Parent $scriptRoot
    $package = Join-Path $root 'vendor\interception-fix'
    $manifest = Assert-Package $package
    # Require Interception keyboard and mouse filters, not merely a bundled DLL.
    Assert-InterceptionDrivers
    Protect-Directory $installDir
    Protect-Directory $dataDir
    Protect-Directory (Join-Path $dataDir 'logs')
    Protect-File (Join-Path $dataDir 'logs\interception-driver-fix.log')
    foreach ($entry in $manifest.files.PSObject.Properties) {
        $destination = Join-Path $installDir $entry.Name
        Protect-File $destination
        Protect-Directory (Split-Path -Parent $destination)
        Copy-Item -LiteralPath (Join-Path $package $entry.Name) -Destination $destination -Force
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $entry.Value) { throw 'Installed file verification failed' }
    }
    foreach ($file in @($iniPath, (Join-Path $dataDir 'installed-at.txt'), (Join-Path $installDir 'manage.ps1'))) { Protect-File $file }
    Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $installDir 'manage.ps1') -Force
    "[default]`r`nlockdown=no`r`nverbose=yes`r`nkeyboard-symlinks=1000`r`npointer-symlinks=1000`r`n" | Set-Content -LiteralPath $iniPath -Encoding ascii
    [DateTime]::UtcNow.ToString('o') | Set-Content -LiteralPath (Join-Path $dataDir 'installed-at.txt') -Encoding ascii
    $created = $false
    try {
        New-Service -Name $serviceName -BinaryPathName $binaryPath -DisplayName 'Axonkey Interception reconnect fix' -StartupType Manual -Description 'Boot-time Interception reconnect compatibility service; lockdown=no; restart after removal.' | Out-Null
        $created = $true
        Invoke-ServiceControl @('privs', $serviceName, 'SeCreatePermanentPrivilege')
        Invoke-ServiceControl @('config', $serviceName, 'start=', 'auto')
    } catch {
        if ($created) { Invoke-ServiceControl @('delete', $serviceName) }
        throw
    }
    Write-FixLog 'Service installed with lockdown=no. Not started now. Restart Windows, then verify input as a standard user.'
    Write-Host 'Installed. Restart Windows before testing. The service has not been started now.'
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
