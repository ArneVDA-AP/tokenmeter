# Removes the Tokenmeter native-messaging host registration (per-user).
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1

$ErrorActionPreference = 'Stop'
$hostName = 'com.tokenmeter.host'
$regKey   = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"

if (Test-Path $regKey) {
    Remove-Item -Path $regKey -Force
    Write-Host "Removed registry key: $regKey" -ForegroundColor Green
} else {
    Write-Host "Registry key not present: $regKey"
}
Write-Host "The manifest/host files under this folder were left in place; delete the repo to remove them."
