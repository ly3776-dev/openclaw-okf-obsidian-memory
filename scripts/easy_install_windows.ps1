param(
  [string]$Vault = "",
  [ValidateSet("CN", "GLOBAL", "CUSTOM")]
  [string]$NetworkProfile = "CN",
  [string]$NpmRegistry = "",
  [string]$PipIndexUrl = "",
  [string]$HfEndpoint = "",
  [string]$ModelHub = "",
  [string]$PaddleModelSource = "",
  [ValidateSet("AUTO", "REUSE_EXISTING", "SIDECAR", "ISOLATED")]
  [string]$InstallMode = "AUTO",
  [switch]$AllowProviderReplace,
  [switch]$NonInteractive,
  [switch]$SkipPrerequisites,
  [switch]$NoOpen,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

function Select-VaultFolder {
  if ($NonInteractive) { throw "-Vault is required with -NonInteractive / 非交互模式必须提供 -Vault。" }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $Dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $Dialog.Description = "选择你的 Obsidian Vault 文件夹 / Select your Obsidian Vault"
    $Dialog.ShowNewFolderButton = $true
    if ($Dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $Dialog.SelectedPath }
  } catch {
    Write-Warning "Folder picker is unavailable / 无法打开目录选择器。"
  }
  return (Read-Host "请输入 Obsidian Vault 完整路径 / Enter the full Obsidian Vault path")
}

function Ensure-Node24 {
  $Node = Get-Command node -ErrorAction SilentlyContinue
  $Ready = $false
  if ($Node) {
    try {
      $Version = (& $Node.Source -p "process.versions.node").Trim()
      $Ready = [version]$Version -ge [version]"24.15.0"
    } catch {}
  }
  if ($Ready) { return }
  Install-WingetPackage "OpenJS.NodeJS.LTS" "Node.js 24 LTS"
  Refresh-ProcessPath
  $Node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $Node) { throw "Node.js installation finished but node is not available. Sign out once, then rerun the installer / Node.js 已安装但当前会话找不到 node，请注销登录一次后重试。" }
  $Version = (& $Node.Source -p "process.versions.node").Trim()
  if ([version]$Version -lt [version]"24.15.0") { throw "Node.js >=24.15.0 is required; found $Version / 需要 Node.js >=24.15.0，当前为 $Version。" }
}

function Ensure-CompatiblePython {
  $Python = Find-CompatiblePython
  if ($Python) { return $Python }
  Install-WingetPackage "Python.Python.3.12" "Python 3.12"
  Refresh-ProcessPath
  $Python = Find-CompatiblePython
  if (-not $Python) { throw "Python 3.12 installation finished but a compatible python.exe was not found. Sign out once, then rerun / Python 3.12 已安装，但当前会话未找到兼容 python.exe，请注销登录一次后重试。" }
  return $Python
}

function Find-CompatiblePython {
  $Candidates = New-Object System.Collections.Generic.List[string]
  foreach ($Name in @("python3.13", "python3.12", "python3.11", "python3.10", "python3.9", "python")) {
    $Command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($Command -and $Command.Source) { $Candidates.Add($Command.Source) }
  }
  $PyLauncher = Get-Command py -ErrorAction SilentlyContinue
  if ($PyLauncher) {
    foreach ($Selector in @("-3.13", "-3.12", "-3.11", "-3.10", "-3.9")) {
      try {
        $Resolved = (& $PyLauncher.Source $Selector -c "import sys;print(sys.executable)" 2>$null).Trim()
        if ($Resolved) { $Candidates.Add($Resolved) }
      } catch {}
    }
  }
  foreach ($Base in @(
    (Join-Path $env:LOCALAPPDATA "Programs\Python"),
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)}
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }) {
    Get-ChildItem -LiteralPath $Base -Filter python.exe -File -Recurse -Depth 3 -ErrorAction SilentlyContinue |
      ForEach-Object { $Candidates.Add($_.FullName) }
  }
  foreach ($Candidate in $Candidates | Select-Object -Unique) {
    try {
      & $Candidate -c "import sys;raise SystemExit(0 if (3,9)<=sys.version_info[:2]<(3,14) else 1)" 2>$null
      if ($LASTEXITCODE -eq 0) { return (Resolve-Path -LiteralPath $Candidate).Path }
    } catch {}
  }
  return ""
}

function Ensure-Ffmpeg {
  if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { return }
  Install-WingetPackage "Gyan.FFmpeg" "FFmpeg"
  Refresh-ProcessPath
  if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Warning "FFmpeg was installed but is not visible in this session. Audio/video use may require signing out once / FFmpeg 已安装，但当前会话尚不可见，音视频功能可能需要注销登录一次。"
  }
}

function Install-WingetPackage([string]$Id, [string]$Label) {
  $Winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $Winget) { throw "$Label is missing and winget is unavailable. Install $Label, then rerun / 缺少 $Label 且未找到 winget，请先安装后重试。" }
  Write-Host "Installing prerequisite / 正在安装前置组件: $Label" -ForegroundColor Yellow
  & $Winget.Source install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
  if ($LASTEXITCODE -ne 0) { throw "winget could not install $Label (exit $LASTEXITCODE) / winget 安装 $Label 失败（退出码 $LASTEXITCODE）。" }
}

function Refresh-ProcessPath {
  $MachinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$MachinePath;$UserPath"
}

function Show-Result([string]$Message, [string]$Title, [switch]$Error) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $Icon = if ($Error) { [System.Windows.Forms.MessageBoxIcon]::Error } else { [System.Windows.Forms.MessageBoxIcon]::Information }
    [System.Windows.Forms.MessageBox]::Show($Message, $Title, [System.Windows.Forms.MessageBoxButtons]::OK, $Icon) | Out-Null
  } catch {}
}

try {
  Write-Host ""
  Write-Host "OKF Obsidian Memory 0.2.x - Easy Installer / 简易安装器" -ForegroundColor Cyan
  Write-Host "The installer will prepare OCR, transcription, BGE-M3, Obsidian and OpenClaw."
  Write-Host "安装器将自动准备 OCR、转录、BGE-M3、Obsidian 和 OpenClaw。"
  Write-Host ""

  if (-not $Vault) { $Vault = Select-VaultFolder }
  if (-not $Vault) { throw "No Obsidian Vault was selected / 没有选择 Obsidian Vault。" }
  $VaultPath = [System.IO.Path]::GetFullPath($Vault)
  if (-not (Test-Path -LiteralPath $VaultPath)) {
    New-Item -ItemType Directory -Path $VaultPath -Force | Out-Null
  }

  if (-not $SkipPrerequisites) {
    Ensure-Node24
    $PythonPath = Ensure-CompatiblePython
    Ensure-Ffmpeg
  } else {
    $PythonPath = Find-CompatiblePython
    if (-not $PythonPath) { throw "Python 3.9-3.13 was not found / 未找到 Python 3.9-3.13。" }
  }

  Write-Host ""
  Write-Host "Vault: $VaultPath" -ForegroundColor Green
  Write-Host "Project / 项目: $Root"
  Write-Host "Python: $PythonPath"
  Write-Host ""

  $BootstrapArgs = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $Root "scripts\bootstrap_windows.ps1"),
    "-Vault", $VaultPath,
    "-PythonPath", $PythonPath,
    "-InstallService",
    "-InstallMode", $InstallMode,
    "-NetworkProfile", $NetworkProfile
  )
  if ($NpmRegistry) { $BootstrapArgs += @("-NpmRegistry", $NpmRegistry) }
  if ($PipIndexUrl) { $BootstrapArgs += @("-PipIndexUrl", $PipIndexUrl) }
  if ($HfEndpoint) { $BootstrapArgs += @("-HfEndpoint", $HfEndpoint) }
  if ($ModelHub) { $BootstrapArgs += @("-ModelHub", $ModelHub) }
  if ($PaddleModelSource) { $BootstrapArgs += @("-PaddleModelSource", $PaddleModelSource) }
  if ($AllowProviderReplace) { $BootstrapArgs += "-AllowProviderReplace" }
  if ($DryRun) {
    Write-Host "Dry run: core installation skipped / 试运行：已跳过核心安装。" -ForegroundColor Yellow
  } else {
    & powershell.exe @BootstrapArgs
    if ($LASTEXITCODE -ne 0) { throw "Core installation failed with exit code $LASTEXITCODE / 核心安装失败，退出码 $LASTEXITCODE。" }
  }

  $AgentFile = Join-Path $Root "AGENT_HANDOFF.md"
  & node (Join-Path $Root "scripts\generate_agent_handoff.js") --root $Root --vault $VaultPath --platform "Windows" --output $AgentFile
  if ($LASTEXITCODE -ne 0) { throw "Agent handoff generation failed / Agent 告知文件生成失败。" }

  Write-Host ""
  Write-Host "Installation complete / 安装完成" -ForegroundColor Green
  Write-Host "1. Open this Vault in Obsidian / 用 Obsidian 打开此 Vault: $VaultPath"
  Write-Host "2. Copy this one file to the Agent / 只需把这个文件复制给 Agent: $AgentFile"
  Write-Host ""
  if (-not $NonInteractive) {
    Show-Result "安装完成。`n`n用 Obsidian 打开：`n$VaultPath`n`n把下面这一个文件复制给 Agent：`n$AgentFile" "OKF Obsidian Memory"
  }
  if (-not $NoOpen -and (Test-Path -LiteralPath $AgentFile)) {
    Start-Process notepad.exe -ArgumentList @($AgentFile) | Out-Null
  }
} catch {
  $Message = $_.Exception.Message
  Write-Error $Message
  if (-not $NonInteractive) {
    Show-Result "安装未完成：`n`n$Message`n`n请修复提示的问题后重新双击 INSTALL_WINDOWS.cmd。" "OKF 安装失败" -Error
  }
  exit 1
}
