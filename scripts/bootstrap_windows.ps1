param(
  [string]$Vault = ".\examples\vault",
  [switch]$InstallBge,
  [switch]$StartBge,
  [switch]$InstallService,
  [ValidateSet("AUTO", "REUSE_EXISTING", "SIDECAR", "ISOLATED")]
  [string]$InstallMode = "AUTO",
  [switch]$AllowProviderReplace,
  [ValidateSet("CN", "GLOBAL", "CUSTOM")]
  [string]$NetworkProfile = "CN",
  [string]$NpmRegistry = "",
  [string]$PipIndexUrl = "",
  [string]$HfEndpoint = "",
  [string]$ModelHub = "",
  [string]$PaddleModelSource = "",
  [string]$PythonPath = "",
  [switch]$SkipOpenClaw,
  [switch]$SkipPython,
  [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"
$LegacyInstallBgeRequested = $InstallBge
if ($LegacyInstallBgeRequested) {
  if ($InstallMode -eq "AUTO") { $InstallMode = "ISOLATED" }
  elseif ($InstallMode -ne "ISOLATED") { throw "-InstallBge conflicts with -InstallMode $InstallMode / -InstallBge 与安装模式冲突。" }
}
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$VaultPath = if ([System.IO.Path]::IsPathRooted($Vault)) {
  [System.IO.Path]::GetFullPath($Vault)
} else {
  [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Vault))
}
Set-Location $Root
$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"

Write-Host "== OKF Obsidian Memory bootstrap (Windows) / 安装（Windows） =="
Write-Host "Root / 项目: $Root"
Write-Host "Vault / 知识库: $VaultPath"

$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) { throw "Node.js 24 LTS is required / 需要 Node.js 24 LTS。" }
$NodeVersionText = (& node -p "process.versions.node").Trim()
if ([version]$NodeVersionText -lt [version]"24.15.0") { throw "Node.js >=24.15.0 LTS is required; found v$NodeVersionText / 需要 Node.js >=24.15.0 LTS。" }

$SourceArgs = @((Join-Path $Root "scripts\resolve_install_sources.js"), "--profile", $NetworkProfile)
if ($NpmRegistry) { $SourceArgs += @("--npm-registry", $NpmRegistry) }
if ($PipIndexUrl) { $SourceArgs += @("--pip-index-url", $PipIndexUrl) }
if ($HfEndpoint) { $SourceArgs += @("--hf-endpoint", $HfEndpoint) }
if ($ModelHub) { $SourceArgs += @("--model-hub", $ModelHub) }
if ($PaddleModelSource) { $SourceArgs += @("--paddle-model-source", $PaddleModelSource) }
$SourceJson = (& node @SourceArgs) -join "`n"
if ($LASTEXITCODE -ne 0) { throw "Dependency source resolution failed / 依赖下载源解析失败" }
$InstallSources = $SourceJson | ConvertFrom-Json
$NpmRegistry = $InstallSources.npmRegistry
$PipIndexUrl = $InstallSources.pipIndexUrl
$HfEndpoint = $InstallSources.hfEndpoint
$ModelHub = $InstallSources.modelHub
$PaddleModelSource = $InstallSources.paddleModelSource
$env:npm_config_registry = $NpmRegistry
$env:npm_config_replace_registry_host = "always"
$env:PIP_INDEX_URL = $PipIndexUrl
$env:PIP_DISABLE_PIP_VERSION_CHECK = "1"
$env:HF_ENDPOINT = $HfEndpoint
$env:HF_HUB_DISABLE_XET = "1"
$env:OKF_MODEL_HUB = $ModelHub
$env:OKF_MODEL_CACHE_DIR = Join-Path $env:LOCALAPPDATA "OKF Obsidian Memory\models"
$env:PADDLE_PDX_MODEL_SOURCE = $PaddleModelSource
Write-Host "Network profile / 下载源方案: $($InstallSources.profile)" -ForegroundColor Cyan
Write-Host "npm: $NpmRegistry"
Write-Host "PyPI: $PipIndexUrl"
Write-Host "Hugging Face: $HfEndpoint"
Write-Host "Model downloads / 模型下载: $ModelHub -> $($env:OKF_MODEL_CACHE_DIR)"
Write-Host "PaddleOCR models / PaddleOCR 模型源: $PaddleModelSource"

if (Test-Path -LiteralPath (Join-Path $Root "package-lock.json")) {
  npm ci --no-audit --no-fund
} else {
  npm install --no-audit --no-fund
}
if ($LASTEXITCODE -ne 0) { throw "npm dependency install failed / npm 依赖安装失败" }

$PlanArgs = @(
  (Join-Path $Root "scripts\plan_openclaw_install.js"),
  "--root", $Root,
  "--mode", $InstallMode
)
if ($AllowProviderReplace) { $PlanArgs += "--allow-provider-replace" }
$PlanJson = (& node @PlanArgs) -join "`n"
if ($LASTEXITCODE -ne 0) { throw "OpenClaw install planning failed / OpenClaw 安装规划失败" }
$Plan = $PlanJson | ConvertFrom-Json
Write-Host "Install mode / 安装模式: $($Plan.resolvedMode) ($($Plan.reason))" -ForegroundColor Cyan
Write-Host "Existing Gateway preserved / 保留现有 Gateway: $($Plan.preserveExistingGateway)"
Write-Host "Install isolated CPU BGE / 安装独立 CPU BGE: $($Plan.installBge)"

if (-not $SkipPython) {
  if (-not (Test-Path -LiteralPath $VenvPython)) {
    $SystemPython = if ($PythonPath) { Get-Item -LiteralPath $PythonPath -ErrorAction SilentlyContinue } else { Get-Command python -ErrorAction SilentlyContinue }
    if (-not $SystemPython) { throw "Python 3.9-3.13 was not found; cannot create .venv / 未找到 Python 3.9-3.13，无法创建 .venv。" }
    $SystemPythonPath = if ($SystemPython.Source) { $SystemPython.Source } else { $SystemPython.FullName }
    & $SystemPythonPath -c "import sys;raise SystemExit(0 if (3,9)<=sys.version_info[:2]<(3,14) else 1)"
    if ($LASTEXITCODE -ne 0) { throw "Python 3.9-3.13 is required / 需要 Python 3.9-3.13。" }
    & $SystemPythonPath -m venv (Join-Path $Root ".venv")
    if ($LASTEXITCODE -ne 0) { throw "Failed to create .venv / 创建 .venv 失败" }
  }
  & $VenvPython -m pip install --upgrade pip
  & $VenvPython -m pip install -r (Join-Path $Root "requirements.txt")
  if ($LASTEXITCODE -ne 0) { throw "Python dependency install failed / Python 依赖安装失败" }
  & $VenvPython (Join-Path $Root "scripts\paddleocr_extract.py") --prepare
  if ($LASTEXITCODE -ne 0) { throw "PaddleOCR model preparation failed / PaddleOCR 模型预下载失败" }
  & $VenvPython (Join-Path $Root "scripts\transcribe_media.py") --prepare --allow-model-download
  if ($LASTEXITCODE -ne 0) { throw "Transcription model preparation failed / 转录模型预下载失败" }
  if ($Plan.installBge) {
    & $VenvPython -m pip install -r (Join-Path $Root "requirements-bge-m3.txt")
    $PrepareArgs = @((Join-Path $Root "scripts\prepare_bge_m3.py"))
    if ($HfEndpoint) { $PrepareArgs += @("--hf-endpoint", $HfEndpoint) }
    & $VenvPython @PrepareArgs
    if ($LASTEXITCODE -ne 0) { throw "BGE-M3 preparation failed / BGE-M3 预下载失败" }
  }
}

$PlanCompact = $Plan | ConvertTo-Json -Compress -Depth 8
$PlanBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PlanCompact))
$SnapshotOutput = & node (Join-Path $Root "scripts\install_snapshot.js") create --root $Root --vault $VaultPath --openclaw-config $Plan.configPath --plan-base64 $PlanBase64 --field snapshotDir
if ($LASTEXITCODE -ne 0 -or -not $SnapshotOutput) { throw "Install snapshot failed / 安装快照失败" }
$SnapshotPath = (($SnapshotOutput -join "").Trim())
Write-Host "Recovery snapshot / 恢复快照: $SnapshotPath" -ForegroundColor Yellow
$GatewayCreated = $false
$BgeServiceCreated = $false
$LocalOpenClaw = Join-Path $Root "node_modules\openclaw\openclaw.mjs"

try {
  & node (Join-Path $Root "scripts\install_obsidian_plugin.js") --root $Root --vault $VaultPath
  if ($LASTEXITCODE -ne 0) { throw "Obsidian plugin install failed / Obsidian 插件安装失败" }

  if ($Plan.installBge -and $InstallService) {
    $ServiceArgs = @("-HfEndpoint", $HfEndpoint)
    & (Join-Path $Root "scripts\install_bge_service_windows.ps1") @ServiceArgs
    if ($LASTEXITCODE -ne 0) { throw "BGE-M3 service install failed / BGE-M3 服务安装失败" }
    $BgeServiceCreated = $true
  } elseif ($Plan.installBge -and $StartBge) {
    $BgeArgs = @()
    if ($HfEndpoint) { $BgeArgs += @("-HfEndpoint", $HfEndpoint) }
    & (Join-Path $Root "scripts\start_bge_m3.ps1") @BgeArgs
    if ($LASTEXITCODE -ne 0) { throw "BGE-M3 start failed / BGE-M3 启动失败" }
  }

  if (-not $SkipOpenClaw) {
    if ($Plan.installBge) {
      $BgeReady = $false
      $BgeDeadline = [DateTime]::UtcNow.AddSeconds(180)
      while ([DateTime]::UtcNow -lt $BgeDeadline) {
        & node (Join-Path $Root "scripts\check_embedding_server.js") *> $null
        if ($LASTEXITCODE -eq 0) { $BgeReady = $true; break }
        Start-Sleep -Seconds 2
      }
      if (-not $BgeReady) { throw "BGE-M3 did not become healthy within 180 seconds / BGE-M3 未在 180 秒内就绪。" }
      & node (Join-Path $Root "scripts\check_embedding_server.js")
    }
    $PluginInstallPath = (& node (Join-Path $Root "scripts\prepare_openclaw_plugin.js") --print-path).Trim()
    if (-not (Test-Path -LiteralPath $PluginInstallPath)) { throw "OpenClaw plugin staging failed / OpenClaw 插件暂存失败" }
    if (-not (Test-Path -LiteralPath $LocalOpenClaw)) { throw "OpenClaw CLI is missing / 未找到 OpenClaw CLI。修复: npm install" }
    & node (Join-Path $Root "scripts\install_openclaw_plugin.js") --root $Root --plugin-path $PluginInstallPath
    if ($LASTEXITCODE -ne 0) { throw "OpenClaw plugin install failed / OpenClaw 插件安装失败" }
    & node (Join-Path $Root "src\cli.js") okf-export --vault $VaultPath
    $MemoryArgs = @((Join-Path $Root "scripts\configure_openclaw_memory.js"), "--vault", $VaultPath, "--mode", $Plan.resolvedMode)
    if ($Plan.configureProvider) { $MemoryArgs += @("--provider", "openai-compatible", "--model", "BAAI/bge-m3") }
    if ($Plan.enableActiveMemory) { $MemoryArgs += "--active-memory" }
    if ($Plan.indexMemory) { $MemoryArgs += "--index" }
    if ($AllowProviderReplace) { $MemoryArgs += "--allow-provider-replace" }
    & node @MemoryArgs
    if ($LASTEXITCODE -ne 0) { throw "OpenClaw memory configuration failed / OpenClaw 记忆配置失败" }
    if ($Plan.installGateway) {
      & node $LocalOpenClaw gateway install --json
      if ($LASTEXITCODE -ne 0) { throw "OpenClaw Gateway service install failed / OpenClaw Gateway 服务安装失败" }
      $GatewayCreated = $true
    }
    if ($Plan.restartGateway) {
      & node $LocalOpenClaw gateway restart --json
    } elseif ($Plan.startGateway) {
      & node $LocalOpenClaw gateway start --json
    }
    if ($LASTEXITCODE -ne 0) { throw "OpenClaw Gateway activation failed / OpenClaw Gateway 启动或重启失败" }
  }

  if (-not $SkipVerify) {
    & node (Join-Path $Root "scripts\setup_check.js") --vault $VaultPath
    & node (Join-Path $Root "src\cli.js") sqlite-index --vault $VaultPath
    & node (Join-Path $Root "scripts\verify_all.js") --skip-openclaw --skip-embedding --skip-obsidian-cli
    if ($LASTEXITCODE -ne 0) { throw "Verification failed / 验证失败" }
  }
  $ChangesJson = $Plan.changes | ConvertTo-Json -Compress
  $ChangesBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ChangesJson))
  & node (Join-Path $Root "scripts\install_snapshot.js") complete --snapshot $SnapshotPath --changes-base64 $ChangesBase64 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not finalize install snapshot / 无法完成安装快照记录" }
} catch {
  $InstallError = $_
  Write-Warning "Installation failed; restoring protected files / 安装失败，正在恢复受保护文件。"
  if ($GatewayCreated -and (Test-Path -LiteralPath $LocalOpenClaw)) { & node $LocalOpenClaw gateway uninstall --json *> $null }
  if ($BgeServiceCreated) { Unregister-ScheduledTask -TaskName "OKF Obsidian BGE-M3" -Confirm:$false -ErrorAction SilentlyContinue }
  & node (Join-Path $Root "scripts\install_snapshot.js") restore --snapshot $SnapshotPath | Out-Null
  if ($Plan.restartGateway -and (Test-Path -LiteralPath $LocalOpenClaw)) { & node $LocalOpenClaw gateway restart --json *> $null }
  throw $InstallError
}

Write-Host "Installation complete / 安装完成。"
Write-Host "Install mode / 安装模式: $($Plan.resolvedMode)"
Write-Host "Recovery snapshot / 恢复快照: $SnapshotPath"
Write-Host "Repair check / 修复检查: npm run setup:check -- --vault `"$VaultPath`""
Write-Host "Obsidian verification / Obsidian 验证: npm run verify:obsidian-cli -- --vault `"$VaultPath`""
