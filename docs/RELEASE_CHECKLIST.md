# Release Checklist / 发布检查清单

Use this checklist before copying the bundle to another OpenClaw + Obsidian machine.

把发布包复制到另一台 OpenClaw + Obsidian 电脑前，按这个清单检查。

## Build / 构建

- [ ] Run `npm run verify:all` on the source machine.
- [ ] Run `npm run release:package`.
- [ ] Run `npm run release:check`.
- [ ] Confirm `release/okf-obsidian-memory-<version>.zip` exists.

## Secrets / 密钥

- [ ] Do not place real API keys in tracked docs, examples, or release files.
- [ ] Put LLM, Tavily, and embedding keys in environment variables or Obsidian plugin settings on the target machine.
- [ ] Confirm `npm run security:check` passes.

## Target Machine / 目标机器

- [ ] Extract the zip.
- [ ] Confirm Node.js >=24.15.0 LTS and Python 3.9-3.13. Python 3.14 is not accepted while PaddlePaddle lacks a compatible wheel.
- [ ] Prefer the easy entry: Windows double-click `INSTALL_WINDOWS.cmd`; Linux run `bash ./install-linux.sh`.
- [ ] On mainland-China networks, keep the default `CN` profile and confirm the installer reports npmmirror, Tsinghua PyPI, ModelScope, and hf-mirror compatibility before downloads. Use `GLOBAL` only when official overseas endpoints are reachable.
- [ ] Confirm the installer generated `AGENT_HANDOFF.md` with the real project and Vault paths; this is the only file the user needs to copy to the Agent.
- [ ] For unattended/advanced deployment only: use `scripts/bootstrap_windows.ps1` or `scripts/bootstrap_linux.sh` directly.
- [ ] Verify `AUTO` resolves healthy existing OpenClaw memory to `REUSE_EXISTING`, unhealthy configured memory to `SIDECAR`, and no provider to `ISOLATED`.
- [ ] Verify an existing Gateway service is preserved and no installer contains `gateway install --force`.
- [ ] Verify snapshot restore returns OpenClaw config and the existing Vault plugin byte-for-byte while leaving user notes untouched.
- [ ] If installing manually, run `npm install`.
- [ ] If installing manually, create `.venv` and install both Python requirement files inside it.
- [ ] Confirm PaddleOCR and Faster-Whisper were prepared during bootstrap. In `ISOLATED`, also confirm BGE-M3 was prepared. Formal ingest must not trigger a model download.
- [ ] If the target has no embedding endpoint, explicitly prepare BGE-M3 and install the Scheduled Task/systemd user service.
- [ ] Generate the minimal OpenClaw staging directory with `node scripts/prepare_openclaw_plugin.js`; do not scan/install the repository `.venv`.
- [ ] Confirm `openclaw gateway status` reports a registered service, `Runtime: running`, and `Connectivity probe: ok`.
- [ ] Install the Obsidian plugin with `node scripts/install_obsidian_plugin.js --vault <Vault>`.
- [ ] Enable the Obsidian plugin and set the project root.
- [ ] On real Linux, complete both phases in `docs/LINUX_M5_VALIDATION.md` and retain both JSON evidence files.
- [ ] On real Windows, run `npm run validate:m5:windows -- --phase pre-reboot`, reboot, let `scripts/run_m5_windows_post_reboot.ps1` complete, and retain both `m5-windows-*-reboot.json` evidence files.

## Verification / 验证

- [ ] Run `npm run setup:check`.
- [ ] Run `npm run verify:plugin`.
- [ ] Run `npm run verify:obsidian`.
- [ ] With Obsidian desktop open, run `npm run verify:obsidian-cli` and require `ok: true`, `skipped: false`, plugin reload success, enabled/version readback, and `No errors captured.` A skipped result is partial evidence only.
- [ ] Run `npm run ui:bilingual`.
- [ ] Run `npm run obsidian:views`.
- [ ] Run `npm run sqlite:index`.
- [ ] Run `npm run release:check`.
- [ ] If embedding and OpenClaw Gateway are available, run `npm run verify:all`.
- [ ] If not, run `npm run verify:all -- --skip-embedding --skip-openclaw`.

## Functional Smoke / 功能烟测

- [ ] Ingest text with `node ./src/cli.js ingest --vault <vault> --text "test memory"`.
- [ ] Run daily synthesis with `node ./src/cli.js daily --vault <vault>`.
- [ ] List ontology actions with `node ./src/cli.js action-list --vault <vault>`.
- [ ] Execute one safe action with `node ./src/cli.js action-execute --vault <vault> --id <action-id>`.
- [ ] Refresh Canvas/Base views with `node ./src/cli.js obsidian-views --vault <vault>`.
- [ ] Rebuild SQLite cache with `node ./src/cli.js sqlite-index --vault <vault>`.
- [ ] Export strict OKF with `node ./src/cli.js okf-export --vault <vault>`.
- [ ] Search memory from OpenClaw or run `npm run verify:openclaw`.
