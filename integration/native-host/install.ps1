# Installs the Tokenmeter native-messaging host for Firefox/Zen (per-user).
#
#   Right-click → Run with PowerShell, or:  powershell -ExecutionPolicy Bypass -File install.ps1
#
# What it does:
#   1. Verifies Node.js is on PATH (the host launcher calls `node`).
#   2. Writes the native manifest with the correct absolute path to the .bat.
#   3. Registers it under HKCU so Firefox/Zen can find it.
#
# Undo with uninstall.ps1.

$ErrorActionPreference = 'Stop'
$here       = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostName   = 'com.tokenmeter.host'
$batPath    = Join-Path $here 'tokenmeter-host.bat'
$manifest   = Join-Path $here 'tokenmeter_host.json'

# 1. Node check
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Warning "Node.js was not found on PATH. The host needs it; install Node 18+ and re-run."
} else {
    Write-Host "Found Node.js: $($node.Source)"
}

if (-not (Test-Path $batPath)) { throw "Launcher not found: $batPath" }

# 2. Write manifest with the resolved launcher path. allowed_extensions must
#    match the (forked) extension's gecko id — change it here if you re-id the fork.
$json = [ordered]@{
    name               = $hostName
    description        = 'Tokenmeter web-usage mirror host'
    path               = $batPath
    type               = 'stdio'
    allowed_extensions = @('claude_usage_tracker@lugia19.com')
}
($json | ConvertTo-Json -Depth 5) | Set-Content -Path $manifest -Encoding UTF8
Write-Host "Wrote manifest: $manifest"

# 3. Register under HKCU (Firefox + Firefox-based forks like Zen use this path)
$regKey = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"
New-Item -Path $regKey -Force | Out-Null
Set-ItemProperty -Path $regKey -Name '(Default)' -Value $manifest
Write-Host "Registered: $regKey -> $manifest"

Write-Host ""
Write-Host "Done. Restart Zen/Firefox, then load the forked extension." -ForegroundColor Green
Write-Host "Note: if Zen does not pick it up, it may use a vendor-specific registry path"
Write-Host "instead of Mozilla\NativeMessagingHosts — check Zen's docs and adjust \$regKey."
