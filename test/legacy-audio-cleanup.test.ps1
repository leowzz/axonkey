$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '../scripts/legacy-audio-cleanup.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($name in @('Get-LegacyAudioDevices', 'Assert-LegacyAudioPackage')) {
    $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($function.Extent.Text))
}

# Query fixtures exercise the real standard-cable selector, without changing PnP state.
function Get-CimInstance {
    param($ClassName, $Filter, $ErrorAction)
    if ($ClassName -ne 'Win32_PnPEntity' -or $Filter -ne "Service='VBAudioVACMME'") { throw 'Unexpected device query.' }
    [pscustomobject]@{ HardwareID = @('VBAudioVACWDM'); PNPDeviceID = 'standard' }
    [pscustomobject]@{ HardwareID = @('vbaudiovacwdm'); PNPDeviceID = 'case-insensitive' }
    [pscustomobject]@{ HardwareID = @('VBAudioVACWDM_A'); PNPDeviceID = 'cable-a' }
    [pscustomobject]@{ HardwareID = @('VoiceMeeter'); PNPDeviceID = 'unrelated' }
}
$devices = @(Get-LegacyAudioDevices)
if ($devices.Count -ne 2 -or $devices[0].PNPDeviceID -ne 'standard') { throw 'Matched a different VB-Audio product.' }

$inf = "[Strings]`r`nHardwareId = `"VBAudioVACWDM`"`r`nServiceName = VBAudioVACMME ; standard driver`r`n"
Assert-LegacyAudioPackage -Name 'oem12.inf' -Inf $inf
Assert-LegacyAudioPackage -Name 'OEM9.INF' -Inf $inf.ToLowerInvariant()
foreach ($bad in @(
    @{ Name = '../oem12.inf'; Inf = $inf },
    @{ Name = 'vbaudio.inf'; Inf = $inf },
    @{ Name = 'oem12.inf'; Inf = $inf.Replace('VBAudioVACWDM', 'VBAudioVACWDM_A') },
    @{ Name = 'oem12.inf'; Inf = $inf.Replace('VBAudioVACMME', 'OtherService') },
    @{ Name = 'oem12.inf'; Inf = ';HardwareId=VBAudioVACWDM;ServiceName=VBAudioVACMME' }
)) {
    $rejected = $false
    try { Assert-LegacyAudioPackage @bad } catch { $rejected = $true }
    if (-not $rejected) { throw 'Accepted an unrelated driver package.' }
}
Write-Host 'PASS: legacy audio device and INF package selection.'
