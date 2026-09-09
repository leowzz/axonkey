[CmdletBinding()]
param(
    [switch]$BuildOnly,
    [switch]$SelfTest,
    [switch]$Frida,
    [string]$PythonPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$sourcePaths = @(
    (Join-Path $repoRoot 'tools\keycode-demo\KeycodeDemo.cs'),
    (Join-Path $repoRoot 'tools\keycode-demo\InterceptionCapture.cs'),
    (Join-Path $repoRoot 'tools\keycode-demo\FridaCapture.cs')
)
$helperSource = Join-Path $repoRoot 'tools\keycode-demo\rc003_hid'
$helperFiles = @(Get-ChildItem -LiteralPath $helperSource -File | Where-Object { $_.Extension -in @('.py', '.md', '.txt') } | Sort-Object Name)
$fingerprintPaths = @($sourcePaths) + @($helperFiles.FullName)
$sourceFingerprint = ($fingerprintPaths | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }) -join ''
$fingerprintHasher = [System.Security.Cryptography.SHA256]::Create()
try { $buildId = ([BitConverter]::ToString($fingerprintHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($sourceFingerprint)))).Replace('-', '').Substring(0, 12).ToLowerInvariant() }
finally { $fingerprintHasher.Dispose() }
# Separate revisions so an open diagnostic window never prevents compiling a fix.
$outputDirectory = Join-Path $repoRoot ".build\keycode-demo\$buildId"
$executablePath = Join-Path $outputDirectory 'Axonkey-KeycodeDemo.exe'
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath)) {
    throw 'This demo requires 64-bit Windows with .NET Framework 4.x.'
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $executablePath)) {
    & $compilerPath /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 `
        /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
        "/out:$executablePath" $sourcePaths
    if ($LASTEXITCODE -ne 0) { throw 'Keycode demo compilation failed.' }
}
if ($Frida) {
    if (-not $PythonPath) { $PythonPath = (Get-Command python.exe -ErrorAction Stop).Source }
    $PythonPath = (Resolve-Path -LiteralPath $PythonPath).Path
    'import ctypes,sys; assert sys.version_info >= (3,10) and ctypes.sizeof(ctypes.c_void_p) == 8' | & $PythonPath -
    if ($LASTEXITCODE -ne 0) { throw 'Frida mode requires 64-bit Python 3.10+.' }
    $helperDestination = Join-Path $outputDirectory 'rc003_hid'
    New-Item -ItemType Directory -Path $helperDestination -Force | Out-Null
    foreach ($helperFile in $helperFiles) { Copy-Item -LiteralPath $helperFile.FullName -Destination $helperDestination -Force }
    [IO.File]::WriteAllText((Join-Path $outputDirectory 'python-path.txt'), $PythonPath, [Text.Encoding]::UTF8)
    if (-not $SelfTest) {
        & (Join-Path $PSScriptRoot 'fetch-frida-gadget.ps1') -Destination (Join-Path $helperDestination 'frida_assets')
    }
} else {
$runtimePath = Join-Path $repoRoot 'vendor\interception\interception.dll'
if ((Get-FileHash -LiteralPath $runtimePath -Algorithm SHA256).Hash -ne 'AB88164C11B1B48488772D4C3BFAA4509D5B0AE9DBC5A691DC4F96F0260443C8') {
    throw 'The bundled Interception runtime hash does not match the reviewed version.'
}
$runtimeCopy = Join-Path $outputDirectory 'interception.dll'
if (-not (Test-Path -LiteralPath $runtimeCopy)) { Copy-Item -LiteralPath $runtimePath -Destination $runtimeCopy }
}
Write-Output "Built: $executablePath"

if ($SelfTest) {
    $testProcess = Start-Process -FilePath $executablePath -ArgumentList '--self-test' -WindowStyle Hidden -Wait -PassThru
    Get-Content -LiteralPath (Join-Path $outputDirectory 'self-test.txt') -Encoding UTF8
    if ($testProcess.ExitCode -ne 0) { throw "Keycode demo self-test failed ($($testProcess.ExitCode))." }
    if ($Frida) {
        Push-Location $outputDirectory
        try {
            & $PythonPath -B -m rc003_hid --self-test
            if ($LASTEXITCODE -ne 0) { throw 'Frida report tests failed.' }
        } finally { Pop-Location }
        if (Get-Command node.exe -ErrorAction SilentlyContinue) {
            & node.exe (Join-Path $repoRoot 'tools\keycode-demo\test-frida-gadget.mjs') $PythonPath
            if ($LASTEXITCODE -ne 0) { throw 'Frida Gadget lifecycle tests failed.' }
        } else { Write-Output 'Node.js unavailable; Gadget JavaScript lifecycle tests skipped.' }
    }
} elseif (-not $BuildOnly) {
    if ($Frida) {
        $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
        if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            Start-Process -FilePath $executablePath -ArgumentList '--frida', '--capture'
        } else {
            # This explicit mode attaches to RC003's system host and needs a UAC elevation.
            Start-Process -FilePath $executablePath -ArgumentList '--frida', '--capture' -Verb RunAs
        }
    } else { Start-Process -FilePath $executablePath }
}
