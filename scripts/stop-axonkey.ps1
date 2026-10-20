$failedProcesses = @()

foreach ($process in @(Get-Process -Name axonkey -ErrorAction SilentlyContinue)) {
    try {
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
    } catch {
        $failedProcesses += $process
    }
}

# Elevated key helpers can exit after their ordinary parent process stops.
if ($failedProcesses.Count -gt 0) {
    Start-Sleep -Milliseconds 500
}

foreach ($process in $failedProcesses) {
    $remaining = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
    if ($remaining -and $remaining.ProcessName -eq 'axonkey') {
        Write-Warning "Could not stop Axonkey (PID $($process.Id)). It may be running as administrator. Exit the old app from its tray menu, or use an administrator terminal to stop it. Development startup will continue."
    }
}

exit 0
