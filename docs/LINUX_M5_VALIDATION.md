# M5 Linux Clean-Environment Validation / M5 Linux 干净环境验收

Run this on a native Linux desktop/user session, or on WSL2 with systemd and WSLg enabled. The validator does not install WSL.

可在原生 Linux 桌面/用户会话中执行，也可在已启用 systemd 和 WSLg 的 WSL2 中执行；验证器本身不会安装 WSL。

## 1. Clean install / 干净安装

Use a newly extracted `0.2.0-rc.1` source/release directory and an existing Obsidian Vault:

Prerequisites are Node.js >=24.15.0 LTS and Python 3.9-3.13. Python 3.14 is not currently supported because the pinned PaddlePaddle release does not provide a compatible wheel. If the distribution only provides Python 3.14, install Python 3.12 or 3.13 separately and pass it explicitly:

```bash
PYTHON=/path/to/python3.12 bash ./scripts/bootstrap_linux.sh \
  --vault "$HOME/Obsidian/MyVault" \
  --install-mode ISOLATED \
  --install-service \
  --network-profile CN
```

前置条件为 Node.js >=24.15.0 LTS 和 Python 3.9-3.13。当前锁定的 PaddlePaddle 尚无 Python 3.14 兼容轮子；若发行版只提供 Python 3.14，请另行安装 Python 3.12/3.13，并通过 `PYTHON` 显式指定。

```bash
bash ./scripts/bootstrap_linux.sh \
  --vault "$HOME/Obsidian/MyVault" \
  --install-mode ISOLATED \
  --install-service \
  --network-profile CN
```

The guided bootstrap prepares PaddleOCR, Faster-Whisper, and BGE-M3 before formal ingest. The `CN` profile routes npm/PyPI/Hugging Face/Paddle model traffic through domestic sources and disables Hugging Face Xet transport for mirror compatibility. Formal ingest remains local-only and never downloads a model silently.

引导安装会在正式 ingest 前准备 PaddleOCR、Faster-Whisper 与 BGE-M3；`CN` 方案会将 npm、PyPI、Hugging Face 和 Paddle 模型流量切换到国内源。正式 ingest 始终只使用本地模型，不会静默下载。

Open that Vault in Obsidian and keep OpenClaw Gateway running. Confirm the current user owns a working systemd user session:

```bash
systemctl --user status okf-bge-m3.service
```

## 2. Pre-reboot evidence / 重启前证据

```bash
node ./scripts/validate_m5_linux.js \
  --vault "$HOME/Obsidian/MyVault" \
  --phase pre-reboot
```

This phase requires all unit tests, real image/PDF/audio/video integration tests, BGE-M3 health, Obsidian plugin reload and `dev:errors`, OpenClaw plugin loading, and actual Active Memory verification to pass.

该阶段要求单元测试、真实图片/PDF/音视频测试、BGE-M3、Obsidian reload/`dev:errors`、OpenClaw 插件和实际主动记忆验证全部通过。

Before running it, `openclaw models status --json --probe` must report a successful live probe for the default model. Static credentials that return 401/403 do not satisfy Active Memory acceptance.

执行前，`openclaw models status --json --probe` 必须确认默认模型实时探测成功；返回 401/403 的静态凭据不能通过主动记忆验收。

## 3. Reboot and post-reboot evidence / 重启与恢复证据

Reboot the Linux host. After login, open the same Vault in Obsidian if desktop auto-start is not configured, then run:

```bash
node ./scripts/validate_m5_linux.js \
  --vault "$HOME/Obsidian/MyVault" \
  --phase post-reboot
```

The validator compares `/proc/sys/kernel/random/boot_id` with the pre-reboot evidence, then rechecks systemd, BGE-M3, Obsidian, OpenClaw, and Active Memory.

## 4. Return evidence / 返回证据

Return both files without editing them:

```text
artifacts/validation/m5-linux-pre-reboot.json
artifacts/validation/m5-linux-post-reboot.json
```

M5 remains incomplete until both files report `"ok": true`.

两个文件均报告 `"ok": true` 后，M5 才能判定通过。
