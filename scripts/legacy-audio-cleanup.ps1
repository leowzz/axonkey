param(
    [ValidateSet('status', 'uninstall')][string]$Action = 'status',
    [Parameter(Mandatory)][string]$OutputPath,
    [string]$LogPath,
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'

function Get-LegacyAudioDevices {
    Get-CimInstance Win32_PnPEntity -Filter "Service='VBAudioVACMME'" -ErrorAction Stop |
        Where-Object { @($_.HardwareID) -contains 'VBAudioVACWDM' }
}

function Assert-LegacyAudioPackage {
    param([string]$Name, [string]$Inf)
    if ($Name -notmatch '^oem\d+\.inf$' -or
        $Inf -notmatch '(?im)^[ \t]*HardwareId[ \t]*=[ \t]*"?VBAudioVACWDM"?[ \t]*(;[^\r\n]*)?\r?$' -or
        $Inf -notmatch '(?im)^[ \t]*ServiceName[ \t]*=[ \t]*"?VBAudioVACMME"?[ \t]*(;[^\r\n]*)?\r?$') {
        throw "Refusing to remove an unrecognized VB-CABLE package: $Name"
    }
}

function Write-CleanupLog {
    param([string]$Message)
    [IO.File]::AppendAllText($LogPath, "$Message`r`n", [Text.UTF8Encoding]::new($false))
}

$reply = [ordered]@{ installed = $null; rebootRequired = $false; error = $null }
$exitCode = 0
try {
    if ($Action -eq 'uninstall') {
        if (-not $LogPath) { throw 'The uninstall log path is required.' }
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            if ($Elevated) { throw 'Administrator privileges are required to uninstall VB-CABLE.' }
            $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Action uninstall -OutputPath "{1}" -LogPath "{2}" -Elevated' -f $PSCommandPath, $OutputPath, $LogPath
            $child = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
            exit $child.ExitCode
        }
        [IO.File]::WriteAllText($LogPath, "VB-CABLE cleanup`r`n", [Text.UTF8Encoding]::new($false))
    }

    $devices = @(Get-LegacyAudioDevices)
    $reply.installed = $devices.Count -gt 0
    if ($Action -eq 'uninstall') {
        # Resolve and verify every package before removing any of them.
        $packages = @($devices | ForEach-Object {
            $name = (Get-PnpDeviceProperty -InstanceId $_.PNPDeviceID -KeyName 'DEVPKEY_Device_DriverInfPath' -ErrorAction Stop).Data
            if ($name -notmatch '^oem\d+\.inf$') { throw "Unexpected published driver name: $name" }
            $inf = Get-Content -LiteralPath (Join-Path "$env:windir\INF" $name) -Raw
            Assert-LegacyAudioPackage -Name $name -Inf $inf
            $name
        } | Sort-Object -Unique)
        foreach ($package in $packages) {
            Write-CleanupLog "Removing $package"
            # Do not pass /reboot: the application reports a pending restart to the user.
            $output = & "$env:SystemRoot\System32\pnputil.exe" /delete-driver $package /uninstall /force 2>&1
            $code = $LASTEXITCODE
            Write-CleanupLog ($output | Out-String)
            if ($code -eq 3010) { $reply.rebootRequired = $true }
            elseif ($code -ne 0) { throw "PnPUtil failed for $package (exit $code)." }
        }
        $reply.installed = @(Get-LegacyAudioDevices).Count -gt 0
        if ($reply.installed -and -not $reply.rebootRequired) {
            throw 'VB-CABLE is still present after uninstall. See the cleanup log.'
        }
    }
} catch {
    $reply.error = $_.Exception.Message
    $exitCode = 1
    if ($LogPath) { try { Write-CleanupLog $reply.error } catch {} }
}
[IO.File]::WriteAllText($OutputPath, ($reply | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
if ($exitCode -eq 0 -and $reply.rebootRequired) { $exitCode = 3010 }
exit $exitCode
