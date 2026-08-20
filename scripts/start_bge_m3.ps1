param(
  [string]$HostName = "127.0.0.1",
  [int]$Port = 8008,
  [string]$ApiKey = "okf-local",
  [string]$Model = "BAAI/bge-m3",
  [string]$Device = "cpu",
  [string]$Backend = "sentence-transformers",
  [string]$ModelCacheDir = "",
  [string]$HfEndpoint = "",
  [switch]$InstallDeps,
  [switch]$Foreground
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Python = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $Python)) { throw ".venv is missing / 缺少 .venv。Run bootstrap_windows.ps1 / 请先运行安装脚本。" }
if ($InstallDeps) { & $Python -m pip install -r (Join-Path $Root "requirements-bge-m3.txt") }
if ($HfEndpoint) { $env:HF_ENDPOINT = $HfEndpoint }
$ArgsList = @(
  (Join-Path $Root "scripts\run_bge_m3_supervisor.py"),
  "--host", $HostName, "--port", "$Port", "--api-key", $ApiKey,
  "--model", $Model, "--device", $Device, "--backend", $Backend
)
if ($ModelCacheDir) { $ArgsList += @("--model-cache-dir", $ModelCacheDir) }
if ($Foreground) { & $Python @ArgsList; exit $LASTEXITCODE }
$LogDir = Join-Path $Root ".logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LauncherOut = Join-Path $LogDir "supervisor-launch.out.log"
$LauncherErr = Join-Path $LogDir "supervisor-launch.err.log"
$Process = Start-Process -FilePath $Python -ArgumentList $ArgsList -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput $LauncherOut -RedirectStandardError $LauncherErr
Write-Host "BGE-M3 supervisor started / BGE-M3 守护进程已启动: pid=$($Process.Id)"
Write-Host "Logs / 日志: $LogDir"
