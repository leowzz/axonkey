# Runs on macOS pwsh as well as Windows. Loads function ASTs only; never invokes
# the script body, UAC, service manager, downloaded binary, or ACL commands.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'scripts/interception-fix.ps1'), [ref]$tokens, [ref]$errors)
if ($errors) { throw ($errors | Out-String) }
foreach ($name in @('Assert-Package', 'Assert-OwnedService', 'Assert-NoReparse', 'Assert-InterceptionDrivers', 'Convert-ToProviderPath')) {
    $functionAst = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    Invoke-Expression $functionAst.Extent.Text
}
function Expect-Failure([scriptblock]$Work, [string]$Expected) {
    try { & $Work } catch { if ($_ -match $Expected) { return }; throw }
    throw "Expected rejection: $Expected"
}
if ((Convert-ToProviderPath '\\?\D:\Tools\AboutSystem\Axonkey\scripts') -ne 'D:\Tools\AboutSystem\Axonkey\scripts') { throw 'Extended drive paths must be normalized for PowerShell providers' }
if ((Convert-ToProviderPath '\\?\UNC\server\share\scripts') -ne '\\?\UNC\server\share\scripts') { throw 'Extended UNC paths must be preserved' }
Expect-Failure { Convert-ToProviderPath '' } 'path is empty'
$binaryPath = '"C:\Program Files\Axonkey Interception Fix\axonkey-interception-fix.exe"'
Assert-OwnedService $null
Assert-OwnedService ([pscustomobject]@{ PathName = $binaryPath; StartName = 'LocalSystem' })
Expect-Failure { Assert-OwnedService ([pscustomobject]@{ PathName = 'C:\foreign.exe'; StartName = 'LocalSystem' }) } 'unexpected service'
Expect-Failure { Assert-OwnedService ([pscustomobject]@{ PathName = $binaryPath; StartName = 'OtherUser' }) } 'unexpected service'
# Model Windows' resolved paths, including a driver installed without a registry
# ImagePath. These mocks never read/write the registry or manage real drivers.
$driverPaths = @{
    keyboard = 'C:\Windows\System32\drivers\keyboard.sys'
    mouse = '\SystemRoot\System32\drivers\mouse.sys'
}
$driverQueries = [Collections.Generic.List[string]]::new()
function Get-CimInstance([string]$ClassName, [string]$Filter) {
    if ($ClassName -ne 'Win32_SystemDriver' -or $Filter -notmatch "^Name='(keyboard|mouse)'$") { throw 'Unexpected driver query' }
    $driver = $Matches[1]
    $driverQueries.Add($driver)
    if ($driverPaths.ContainsKey($driver)) { [pscustomobject]@{ Name = $driver; PathName = $driverPaths[$driver] } }
}
Assert-InterceptionDrivers
if (($driverQueries -join ',') -ne 'keyboard,mouse') { throw 'Both Interception filters must be checked' }
$driverPaths.Remove('mouse')
Expect-Failure { Assert-InterceptionDrivers } 'Install the Interception input driver'
$driverPaths.mouse = 'C:\Windows\System32\drivers\other.sys'
Expect-Failure { Assert-InterceptionDrivers } 'Install the Interception input driver'
$driverPaths.mouse = $null
Expect-Failure { Assert-InterceptionDrivers } 'Install the Interception input driver'
$driverPaths.mouse = 'C:\Windows\System32\drivers\mouse.sys'
$driverPaths.Remove('keyboard')
Expect-Failure { Assert-InterceptionDrivers } 'Install the Interception input driver'
Remove-Item Function:\Get-CimInstance
$temp = Join-Path $root ('.build/fix-test-' + [Guid]::NewGuid().ToString())
try {
    New-Item -ItemType Directory (Join-Path $temp 'licenses') -Force | Out-Null
    $bytes = New-Object byte[] 128
    $bytes[0] = 0x4d; $bytes[1] = 0x5a; $bytes[0x3c] = 64
    $bytes[64] = 0x50; $bytes[65] = 0x45; $bytes[68] = 0x64; $bytes[69] = 0x86
    [IO.File]::WriteAllBytes((Join-Path $temp 'axonkey-interception-fix.exe'), $bytes)
    $files = @{'axonkey-interception-fix.exe' = (Get-FileHash (Join-Path $temp 'axonkey-interception-fix.exe')).Hash.ToLowerInvariant()}
    foreach ($name in @('interception-driver-fix', 'scope-guard-MIT', 'cli11', 'fmt', 'spdlog', 'boost-algorithm', 'phnt')) {
        $path = "licenses/$name.txt"
        'test license' | Set-Content (Join-Path $temp $path)
        $files[$path] = (Get-FileHash (Join-Path $temp $path)).Hash.ToLowerInvariant()
    }
    $manifest = @{ upstreamCommit = 'e1a7720863f514d51caf06b020da5c0d2e345c41'; vcpkgCommit = '2750401336fb7c95f6619657a46a7e798661341c'; files = $files }
    $manifest | ConvertTo-Json | Set-Content (Join-Path $temp 'manifest.json')
    Assert-Package $temp | Out-Null
    $files['../escape'] = 'a' * 64
    $manifest | ConvertTo-Json | Set-Content (Join-Path $temp 'manifest.json')
    Expect-Failure { Assert-Package $temp } 'Invalid package manifest'
    $files.Remove('../escape')
    $manifest | ConvertTo-Json | Set-Content (Join-Path $temp 'manifest.json')
    'tampered' | Set-Content (Join-Path $temp 'axonkey-interception-fix.exe')
    Expect-Failure { Assert-Package $temp } 'SHA-256 mismatch'
    Remove-Item (Join-Path $temp 'licenses/cli11.txt')
    Expect-Failure { Assert-Package $temp } 'Cannot find path|Could not find file|SHA-256 mismatch'
} finally { Remove-Item -LiteralPath $temp -Recurse -Force }
Write-Host 'PASS: syntax, service ownership, resolved driver paths, missing/invalid filters, valid payload, traversal, tamper and missing-file rejection; no service/ACL operations.'
