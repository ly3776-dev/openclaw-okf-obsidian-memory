param(
  [string]$Root = "E:\codex项目\op_okf_obsidian",
  [string]$Vault = "E:\codex项目\op_okf_obsidian\examples\vault",
  [string]$ObsidianExe = "D:\Program Files\Obsidian\Obsidian.exe",
  [string]$ObsidianCli = "D:\Program Files\Obsidian\Obsidian.com",
  [string]$TaskName = "OKF M5 Post-Reboot Validation"
)

$ErrorActionPreference = "Stop"
$artifactDir = Join-Path $Root "artifacts\validation"
$logPath = Join-Path $artifactDir "m5-windows-post-reboot.log"
$node = "C:\Program Files\nodejs\node.exe"
$validator = Join-Path $Root "scripts\validate_m5_windows.js"

try {
  Start-Sleep -Seconds 30
  if (-not (Get-Process -Name Obsidian -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $ObsidianExe)) {
    Start-Process -FilePath $ObsidianExe
    Start-Sleep -Seconds 20
  }
  Set-Location -LiteralPath $Root
  $env:OKF_OPENCLAW_VERIFY_TIMEOUT_MS = "300000"
  & $node $validator --vault $Vault --obsidian $ObsidianCli --phase post-reboot *>&1 | Tee-Object -FilePath $logPath
  $validatorExit = $LASTEXITCODE
} catch {
  $_ | Out-String | Add-Content -LiteralPath $logPath
  $validatorExit = 1
} finally {
  Remove-Item Env:OKF_OPENCLAW_VERIFY_TIMEOUT_MS -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}

exit $validatorExit
