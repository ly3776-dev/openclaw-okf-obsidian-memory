param(
  [string]$TaskName = "OKF Obsidian BGE-M3",
  [string]$HfEndpoint = "",
  [switch]$NoStart
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Python = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $Python)) { throw ".venv is missing / 缺少 .venv。请先运行 bootstrap_windows.ps1 -InstallMode ISOLATED" }
$BasePython = (& $Python -c "import sys; print(sys._base_executable)").Trim()
if (-not (Test-Path -LiteralPath $BasePython)) { throw "Base Python is missing / 缺少基础 Python: $BasePython" }
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($ExistingTask) {
  throw "Scheduled Task already exists and will not be overwritten / 同名计划任务已存在，安装器不会覆盖: $TaskName"
}
$Supervisor = Join-Path $Root "scripts\run_bge_m3_supervisor.py"
$Arguments = '"' + $Supervisor + '" --python "' + $Python + '"'
if ($HfEndpoint) { [Environment]::SetEnvironmentVariable("HF_ENDPOINT", $HfEndpoint, "User") }
$Action = New-ScheduledTaskAction -Execute $BasePython -Argument $Arguments -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "OKF BGE-M3 embedding service with health monitoring / 带健康检查的 OKF BGE-M3 服务" | Out-Null
if (-not $NoStart) { Start-ScheduledTask -TaskName $TaskName }
Write-Host "Scheduled Task installed / 已安装计划任务: $TaskName"
Write-Host "Logs / 日志: $Root\.logs"
