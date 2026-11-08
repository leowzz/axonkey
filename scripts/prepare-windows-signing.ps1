param(
    [string]$CertificatePath = $env:WINDOWS_CERTIFICATE_PATH,
    [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri/target/windows-signing.json')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $CertificatePath) { $CertificatePath = Join-Path $root 'secrets/windows-signing.pfx' }
if (-not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) {
    throw 'Windows signing PFX is missing. Set WINDOWS_CERTIFICATE_PATH or provide secrets/windows-signing.pfx.'
}
$password = $env:WINDOWS_CERTIFICATE_PASSWORD
if (-not $password) {
    $passwordPath = Join-Path $root 'secrets/windows-signing-password.txt'
    if (Test-Path -LiteralPath $passwordPath) { $password = [IO.File]::ReadAllText($passwordPath).TrimEnd([char[]]"`r`n") }
}
if (-not $password) { throw 'WINDOWS_CERTIFICATE_PASSWORD is required.' }

$securePassword = ConvertTo-SecureString -String $password -AsPlainText -Force
$certificates = @(Import-PfxCertificate -FilePath $CertificatePath -Password $securePassword -CertStoreLocation Cert:\CurrentUser\My)
$signers = @($certificates | Where-Object { $_.HasPrivateKey -and $_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3' })
if ($signers.Count -ne 1) { throw 'PFX must contain exactly one code-signing certificate with a private key.' }
$certificate = $signers[0]
if ($certificate.NotBefore -gt (Get-Date) -or $certificate.NotAfter -le (Get-Date)) {
    throw 'Windows signing certificate is outside its validity period.'
}

$config = @{
    bundle = @{
        windows = @{
            certificateThumbprint = $certificate.Thumbprint
            digestAlgorithm = 'sha256'
            timestampUrl = 'http://timestamp.digicert.com'
            tsp = $true
        }
    }
}
$null = New-Item -ItemType Directory -Path (Split-Path -Parent $ConfigPath) -Force
[IO.File]::WriteAllText($ConfigPath, ($config | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
Write-Output $ConfigPath
