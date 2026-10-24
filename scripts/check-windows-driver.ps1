#requires -Version 7.2
<#
Checks the bundled package, installer CLI and driver-store staging on a disposable
Windows runner. Does not bind a device, load the driver or test UAC/RC003 input.
TrustPublisherForCI temporarily trusts the verified catalog signer on GitHub-hosted
runners to avoid the interactive publisher prompt. It never adds a root certificate.
#>
[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputDirectory = (Join-Path ([IO.Path]::GetTempPath()) ('quarbor-check-' + [guid]::NewGuid().ToString('N'))),
    [switch]$TrustPublisherForCI
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-LoggedProcess {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$LogPrefix,
        [int]$TimeoutSeconds = 60
    )
    $process = [Diagnostics.Process]::new()
    $process.StartInfo.FileName = $FilePath
    $process.StartInfo.WorkingDirectory = Split-Path -Parent $FilePath
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $process.StartInfo.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($argument in $Arguments) { $process.StartInfo.ArgumentList.Add($argument) }
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $timedOut = -not $process.WaitForExit($TimeoutSeconds * 1000)
        if ($timedOut) { $process.Kill($true) }
        $process.WaitForExit()
        $result = [pscustomobject]@{
            exitCode = $process.ExitCode
            stdout = $stdout.GetAwaiter().GetResult()
            stderr = $stderr.GetAwaiter().GetResult()
        }
        $result.stdout | Set-Content -LiteralPath "$LogPrefix.stdout.log" -Encoding utf8
        $result.stderr | Set-Content -LiteralPath "$LogPrefix.stderr.log" -Encoding utf8
        @{ executable = $FilePath; arguments = $Arguments; exitCode = $result.exitCode; timedOut = $timedOut } |
            ConvertTo-Json -Depth 4 | Set-Content -LiteralPath "$LogPrefix.process.json" -Encoding utf8
        if ($timedOut) { throw "$FilePath timed out after $TimeoutSeconds seconds. See $LogPrefix.*" }
        return $result
    } finally {
        $process.Dispose()
    }
}

function Assert-InstallerReply {
    param([string]$Json, [int]$ExitCode, [string]$Action, [int]$ExpectedExitCode = 0)
    $reply = $Json.TrimStart([char]0xfeff) | ConvertFrom-Json
    if (($reply.version -isnot [int] -and $reply.version -isnot [long]) -or
        ($reply.exitCode -isnot [int] -and $reply.exitCode -isnot [long]) -or
        $reply.version -ne 1 -or $reply.exitCode -ne $ExitCode -or $ExitCode -ne $ExpectedExitCode) {
        throw "Installer version or exit code mismatch: process=$ExitCode, expected=$ExpectedExitCode."
    }
    if ($reply.action -isnot [string] -or ($Action -and $reply.action -ne $Action)) { throw "Unexpected installer action: $($reply.action)." }
    $expectedOutcomes = if ($ExpectedExitCode -eq 0) { @('success', 'success_with_warnings') } else { @('failed') }
    if ($reply.outcome -isnot [string] -or $reply.outcome -notin $expectedOutcomes -or
        $reply.rebootRequired -isnot [bool] -or $reply.rebootRequired) {
        throw "Unexpected installer outcome: $($reply.outcome)."
    }
    if ($reply.message -isnot [string]) { throw 'Installer message must be a string.' }
    if ($Action -eq 'list') {
        if ($reply.devices -isnot [array]) { throw 'Installer devices must be an array (an empty array is valid without hardware).' }
        foreach ($device in $reply.devices) {
            if ($device.instanceId -isnot [string] -or [string]::IsNullOrWhiteSpace($device.instanceId) -or
                ($null -ne $device.name -and $device.name -isnot [string]) -or
                ($null -ne $device.driverVersion -and $device.driverVersion -isnot [string]) -or
                ($null -ne $device.upgradeAvailable -and $device.upgradeAvailable -isnot [bool]) -or
                ($null -ne $device.upgradeStatus -and $device.upgradeStatus -isnot [string]) -or
                $device.present -isnot [bool] -or $device.bound -isnot [bool] -or
                ($null -ne $device.recoverySaved -and $device.recoverySaved -isnot [bool]) -or
                $device.recoveryActive -isnot [bool]) {
                throw 'Installer returned an invalid device record.'
            }
        }
    }
    return $reply
}

function Get-NewQuarborPackages {
    param([object[]]$Before, [object[]]$After)
    $existingNames = @($Before | ForEach-Object { $_.Driver })
    $After | Where-Object {
        [IO.Path]::GetFileName($_.OriginalFileName) -ieq 'QuarborUniversalKeyboardDriver.inf' -and
        $_.Driver -match '^oem\d+\.inf$' -and $_.Driver -notin $existingNames
    }
}

function Invoke-WithTrustedPublisher {
    param($Signature, $Store, [scriptblock]$Action)
    if ($Signature.Status -ne 'Valid' -or -not $Signature.SignerCertificate) {
        throw 'Cannot trust a publisher before its signature has been verified.'
    }
    $certificate = $Signature.SignerCertificate
    $added = $false
    try {
        $Store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        $existing = @($Store.Certificates | Where-Object Thumbprint -eq $certificate.Thumbprint)
        if ($existing.Count -eq 0) {
            $Store.Add($certificate)
            $added = $true
            Write-Host "Temporarily trusted catalog publisher: $($certificate.Subject) [$($certificate.Thumbprint)]"
        }
        & $Action
    } finally {
        try {
            if ($added) {
                $Store.Remove($certificate)
                Write-Host "Removed temporary publisher trust: $($certificate.Thumbprint)"
            }
        } finally {
            $Store.Close()
        }
    }
}

function Test-WindowsDriverPackage {
    param([string]$Root, [string]$Logs, [switch]$TrustPublisherForCI)
    if ($TrustPublisherForCI -and ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted')) {
        throw '-TrustPublisherForCI is only supported on disposable GitHub-hosted runners.'
    }
    if (-not $IsWindows) { throw 'Driver-store checks require Windows.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Driver-store checks require an elevated PowerShell session.'
    }
    # Refuse to reuse output files: the installer's --output creates a new file exclusively.
    [void](New-Item -ItemType Directory -Path $Logs)
    $Logs = (Resolve-Path -LiteralPath $Logs).Path
    $Root = (Resolve-Path -LiteralPath $Root).Path
    $package = Join-Path $Root 'vendor/QuarborUniversalKeyboardDriverInstaller'
    $exe = Join-Path $package 'QuarborUniversalKeyboardDriverInstaller.exe'
    $inf = Join-Path $package 'QuarborUniversalKeyboardDriver.inf'
    $catalog = Join-Path $package 'QuarborUniversalKeyboardDriver.cat'
    $pnputil = Join-Path $env:WINDIR 'System32/pnputil.exe'
    $before = @()
    $stagingAttempted = $false
    $failure = $null
    Start-Transcript -Path (Join-Path $Logs 'check.log') | Out-Null
    try {
        Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Logs 'os.json') -Encoding utf8
        $config = Get-Content -LiteralPath (Join-Path $Root 'src-tauri/tauri.windows.conf.json') -Raw | ConvertFrom-Json -AsHashtable
        $files = @('QuarborUniversalKeyboardDriverInstaller.exe', 'QuarborUniversalKeyboardDriver.inf',
            'QuarborUniversalKeyboardDriver.dll', 'QuarborUniversalKeyboardDriver.cat', 'License')
        $hashes = foreach ($file in $files) {
            $path = Join-Path $package $file
            if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -eq 0) {
                throw "Missing or empty bundled resource: $path"
            }
            $resource = @($config.bundle.resources.GetEnumerator() | Where-Object { $_.Key -ieq "../vendor/QuarborUniversalKeyboardDriverInstaller/$file" })
            if ($resource.Count -ne 1 -or $resource[0].Value -ine "vendor/QuarborUniversalKeyboardDriverInstaller/$file") {
                throw "Windows bundle must include $file at the installer's resource path."
            }
            Get-FileHash -LiteralPath $path -Algorithm SHA256 | Select-Object Path, Hash
        }
        $hashes | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Logs 'package-sha256.json') -Encoding utf8
        $catalogSignature = Get-AuthenticodeSignature -LiteralPath $catalog
        $signatures = @((Get-AuthenticodeSignature -LiteralPath $exe), $catalogSignature)
        $signatures | Select-Object Path, Status, StatusMessage, @{Name = 'Signer'; Expression = { if ($_.SignerCertificate) { $_.SignerCertificate.Subject } }} |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Logs 'signatures.json') -Encoding utf8
        if (@($signatures | Where-Object Status -ne 'Valid').Count -ne 0) { throw 'Installer or catalog signature is not valid.' }
        $sdkBin = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
        $signtool = Get-ChildItem -Path "$sdkBin/*/x64/signtool.exe" |
            Sort-Object { [version]$_.Directory.Parent.Name } -Descending | Select-Object -First 1
        if (-not $signtool) { throw 'Windows SDK x64 signtool.exe was not found.' }
        foreach ($file in @('QuarborUniversalKeyboardDriver.inf', 'QuarborUniversalKeyboardDriver.dll')) {
            $verification = Invoke-LoggedProcess -FilePath $signtool.FullName -Arguments @('verify', '/pa', '/v', '/c', $catalog, (Join-Path $package $file)) -LogPrefix (Join-Path $Logs "catalog-$file")
            if ($verification.exitCode -ne 0) { throw "Catalog verification failed for $file. See catalog-$file.*" }
        }
        $output = Join-Path $Logs 'installer-list.json'
        $list = Invoke-LoggedProcess -FilePath $exe -Arguments @('--list', '--output', $output) -LogPrefix (Join-Path $Logs 'installer-list')
        $null = Assert-InstallerReply -Json $list.stdout -ExitCode $list.exitCode -Action 'list'
        $saved = Get-Content -LiteralPath $output -Raw -Encoding utf8
        $null = Assert-InstallerReply -Json $saved -ExitCode $list.exitCode -Action 'list'
        if ($list.stdout.Trim().TrimStart([char]0xfeff) -cne $saved.Trim().TrimStart([char]0xfeff)) {
            throw 'Installer stdout and --output result differ.'
        }
        # Missing device ID must fail validation, without performing a device operation.
        $invalid = Invoke-LoggedProcess -FilePath $exe -Arguments @('--install') -LogPrefix (Join-Path $Logs 'installer-invalid-args')
        $null = Assert-InstallerReply -Json $invalid.stdout -ExitCode $invalid.exitCode -ExpectedExitCode 87

        $before = @(Get-WindowsDriver -Online -LogPath (Join-Path $Logs 'dism-before.log'))
        $before | Select-Object Driver, OriginalFileName, ProviderName, Version |
            ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Logs 'driver-store-before.json') -Encoding utf8
        $stagingAttempted = $true
        # Deliberately omit /install: a hosted runner has no RC003 to bind.
        $stagePackage = {
            Invoke-LoggedProcess -FilePath $pnputil -Arguments @('/add-driver', $inf) -LogPrefix (Join-Path $Logs 'pnputil-add')
        }
        if ($TrustPublisherForCI) {
            # Authenticode and catalog membership were verified above. A valid signature
            # does not itself suppress Windows' publisher-consent dialog (0xe0000242).
            # https://learn.microsoft.com/windows-hardware/drivers/install/trusted-publishers-certificate-store
            $publisherStore = [Security.Cryptography.X509Certificates.X509Store]::new('TrustedPublisher', 'LocalMachine')
            $stage = Invoke-WithTrustedPublisher -Signature $catalogSignature -Store $publisherStore -Action $stagePackage
        } else {
            $stage = & $stagePackage
        }
        if ($stage.exitCode -ne 0) { throw "Driver-store staging failed: exit $($stage.exitCode). See pnputil-add.* and setupapi.dev.log." }
        $after = @(Get-WindowsDriver -Online -LogPath (Join-Path $Logs 'dism-after.log'))
        $after | Select-Object Driver, OriginalFileName, ProviderName, Version |
            ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Logs 'driver-store-after.json') -Encoding utf8
        $expectedHash = (Get-FileHash -LiteralPath $inf -Algorithm SHA256).Hash
        $matching = @($after | Where-Object {
            [IO.Path]::GetFileName($_.OriginalFileName) -ieq 'QuarborUniversalKeyboardDriver.inf' -and
            (Get-FileHash -LiteralPath $_.OriginalFileName -Algorithm SHA256).Hash -eq $expectedHash
        })
        if ($matching.Count -eq 0) { throw 'PnPUtil returned success, but the expected INF is absent from the driver store.' }
    } catch {
        $failure = $_
        Write-Warning $_
    } finally {
        try {
            if ($stagingAttempted) {
                $current = @(Get-WindowsDriver -Online -LogPath (Join-Path $Logs 'dism-cleanup.log'))
                foreach ($driver in @(Get-NewQuarborPackages -Before $before -After $current)) {
                    # Remove only newly staged packages. Never force removal or unbind a device.
                    $cleanup = Invoke-LoggedProcess -FilePath $pnputil -Arguments @('/delete-driver', $driver.Driver) -LogPrefix (Join-Path $Logs "cleanup-$($driver.Driver)")
                    if ($cleanup.exitCode -ne 0) { throw "Cannot remove staged package $($driver.Driver): exit $($cleanup.exitCode)." }
                }
                $remaining = @(Get-WindowsDriver -Online -LogPath (Join-Path $Logs 'dism-cleanup.log'))
                if (@(Get-NewQuarborPackages -Before $before -After $remaining).Count -ne 0) { throw 'New Quarbor packages remain after cleanup.' }
            }
        } catch {
            Write-Warning "Cleanup failed: $_"
            if (-not $failure) { $failure = $_ }
        }
        foreach ($name in @('setupapi.dev.log', 'setupapi.app.log')) {
            $path = Join-Path $env:WINDIR "INF/$name"
            if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination $Logs -ErrorAction Continue }
        }
        Stop-Transcript | Out-Null
    }
    if ($failure) { throw $failure }
    Write-Host 'PASS: package resources, signatures, installer CLI and driver-store staging. Device binding/loading was not tested.'
}

if ($MyInvocation.InvocationName -ne '.') {
    Test-WindowsDriverPackage -Root $RepositoryRoot -Logs $OutputDirectory -TrustPublisherForCI:$TrustPublisherForCI
}
