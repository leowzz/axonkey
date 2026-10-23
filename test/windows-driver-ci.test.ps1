#requires -Version 7.2
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../scripts/check-windows-driver.ps1"

function Assert-Rejected {
    param([scriptblock]$Action)
    $rejected = $false
    try { $null = & $Action } catch { $rejected = $true }
    if (-not $rejected) { throw 'Expected malformed or failed installer result to be rejected.' }
}

$list = '{"version":1,"action":"list","outcome":"success","exitCode":0,"rebootRequired":false,"message":"ok","devices":[]}'
$reply = Assert-InstallerReply -Json $list -ExitCode 0 -Action list
if ($reply.devices.Count -ne 0) { throw 'Hardware-free list should accept an empty device array.' }
$null = Assert-InstallerReply -Json ([string][char]0xfeff + $list) -ExitCode 0 -Action list
Assert-Rejected { Assert-InstallerReply -Json $list -ExitCode 259 -Action list }
Assert-Rejected { Assert-InstallerReply -Json $list -ExitCode 0 -Action install }
Assert-Rejected { Assert-InstallerReply -Json ($list.Replace('"version":1', '"version":"1"')) -ExitCode 0 -Action list }
Assert-Rejected { Assert-InstallerReply -Json ($list.Replace('"version":1', '"version":2')) -ExitCode 0 -Action list }
Assert-Rejected { Assert-InstallerReply -Json ($list.Replace('"success"', '"failed"')) -ExitCode 0 -Action list }
Assert-Rejected { Assert-InstallerReply -Json ($list.Replace('"rebootRequired":false', '"rebootRequired":true')) -ExitCode 0 -Action list }
Assert-Rejected { Assert-InstallerReply -Json ($list.Replace('"devices":[]', '"devices":{}')) -ExitCode 0 -Action list }
Assert-Rejected { Assert-InstallerReply -Json ($list.Replace('"devices":[]', '"devices":[{"instanceId":"HID\\test"}]')) -ExitCode 0 -Action list }
Assert-Rejected { Assert-InstallerReply -Json 'not JSON' -ExitCode 0 -Action list }
$invalid = '{"version":1,"action":"install","outcome":"failed","exitCode":87,"rebootRequired":false,"message":"missing device"}'
$null = Assert-InstallerReply -Json $invalid -ExitCode 87 -ExpectedExitCode 87
Assert-Rejected { Assert-InstallerReply -Json $invalid -ExitCode 0 -ExpectedExitCode 87 }

# Cleanup must preserve pre-existing Quarbor packages and unrelated/new vendor packages.
$before = @([pscustomobject]@{ Driver = 'oem1.inf'; OriginalFileName = '/store/QuarborHIDFilterUserDriver.inf' })
$after = $before + @(
    [pscustomobject]@{ Driver = 'oem2.inf'; OriginalFileName = '/store/quarborhidfilteruserdriver.inf' },
    [pscustomobject]@{ Driver = 'oem3.inf'; OriginalFileName = '/store/another-driver.inf' },
    [pscustomobject]@{ Driver = 'keyboard.inf'; OriginalFileName = '/store/QuarborHIDFilterUserDriver.inf' }
)
$new = @(Get-NewQuarborPackages -Before $before -After $after)
if ($new.Count -ne 1 -or $new[0].Driver -ne 'oem2.inf') { throw 'Cleanup selected packages outside this staging operation.' }
if (@(Get-NewQuarborPackages -Before @() -After @()).Count -ne 0) { throw 'Empty store should need no cleanup.' }

$temporary = Join-Path ([IO.Path]::GetTempPath()) ('quarbor-ci-test-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $temporary)
try {
    $pwsh = (Get-Process -Id $PID).Path
    $prefix = Join-Path $temporary 'process'
    $result = Invoke-LoggedProcess -FilePath $pwsh -Arguments @('-NoProfile', '-Command', '[Console]::Out.Write("hello"); [Console]::Error.Write("failure"); exit 87') -LogPrefix $prefix
    if ($result.exitCode -ne 87 -or $result.stdout -ne 'hello' -or $result.stderr -ne 'failure') { throw 'Native process result was lost.' }
    if ((Get-Content -LiteralPath "$prefix.process.json" -Raw | ConvertFrom-Json).exitCode -ne 87) { throw 'Missing process diagnostics.' }
    $timeoutPrefix = Join-Path $temporary 'timeout'
    Assert-Rejected { Invoke-LoggedProcess -FilePath $pwsh -Arguments @('-NoProfile', '-Command', 'Start-Sleep -Seconds 30') -LogPrefix $timeoutPrefix -TimeoutSeconds 1 }
    if (-not (Get-Content -LiteralPath "$timeoutPrefix.process.json" -Raw | ConvertFrom-Json).timedOut) { throw 'Timeout was not recorded.' }
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
Write-Host 'PASS: installer contract, cleanup scope, native exit codes and process timeouts.'
