#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$prepare = Join-Path $PSScriptRoot '../scripts/prepare-windows-signing.ps1'
$directory = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$null = New-Item -ItemType Directory -Path $directory
$previousPassword = $env:WINDOWS_CERTIFICATE_PASSWORD
$certificates = @()

function Assert-Rejected {
    param([scriptblock]$Action)
    $rejected = $false
    try { $null = & $Action } catch { $rejected = $true }
    if (-not $rejected) { throw 'Expected invalid Windows signing inputs to be rejected.' }
}

try {
    $env:WINDOWS_CERTIFICATE_PASSWORD = [guid]::NewGuid().ToString()
    $password = ConvertTo-SecureString $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
    $pfx = Join-Path $directory 'signer.pfx'
    $configPath = Join-Path $directory 'config/signing.json'
    Assert-Rejected { & $prepare -CertificatePath $pfx -ConfigPath $configPath }
    if (Test-Path -LiteralPath $configPath) { throw 'Missing PFX must not produce a signing configuration.' }

    $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Axonkey signing test' -CertStoreLocation Cert:\CurrentUser\My
    $certificates += $certificate
    $null = Export-PfxCertificate -Cert $certificate -FilePath $pfx -Password $password
    Remove-Item "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -Force
    $env:WINDOWS_CERTIFICATE_PASSWORD = 'incorrect password'
    Assert-Rejected { & $prepare -CertificatePath $pfx -ConfigPath $configPath }
    if (Test-Path -LiteralPath $configPath) { throw 'Wrong password must not produce a signing configuration.' }

    $env:WINDOWS_CERTIFICATE_PASSWORD = [System.Net.NetworkCredential]::new('', $password).Password
    $result = & $prepare -CertificatePath $pfx -ConfigPath $configPath
    if ($result -ne $configPath) { throw 'Preparation must return only the generated configuration path.' }
    $windows = (Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).bundle.windows
    $jsonBytes = [IO.File]::ReadAllBytes($configPath)
    if ($jsonBytes[0] -eq 0xef) { throw 'Signing JSON must not have a UTF-8 BOM, including under Windows PowerShell 5.1.' }
    if ($windows.certificateThumbprint -ne $certificate.Thumbprint -or $windows.digestAlgorithm -ne 'sha256' -or
        -not $windows.tsp -or $windows.timestampUrl -ne 'http://timestamp.digicert.com') {
        throw 'Signing configuration does not describe the imported certificate and SHA-256 timestamping.'
    }
    if (-not (Get-Item "Cert:\CurrentUser\My\$($certificate.Thumbprint)").HasPrivateKey) { throw 'Signing key was not imported.' }
    if (Test-Path "Cert:\CurrentUser\Root\$($certificate.Thumbprint)") { throw 'Preparation must not trust the certificate.' }

    Remove-Item -LiteralPath $configPath
    $serverCertificate = New-SelfSignedCertificate -DnsName 'axonkey-signing-test.invalid' -CertStoreLocation Cert:\CurrentUser\My
    $certificates += $serverCertificate
    $serverPfx = Join-Path $directory 'server.pfx'
    $null = Export-PfxCertificate -Cert $serverCertificate -FilePath $serverPfx -Password $password
    Assert-Rejected { & $prepare -CertificatePath $serverPfx -ConfigPath $configPath }
    if (Test-Path -LiteralPath $configPath) { throw 'A server certificate must not enable code signing.' }
    Write-Host 'Windows signing preparation tests passed.'
} finally {
    $env:WINDOWS_CERTIFICATE_PASSWORD = $previousPassword
    foreach ($certificate in $certificates) {
        Remove-Item "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $directory -Recurse -Force
}
