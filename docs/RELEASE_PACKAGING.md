# Release Packaging / 发布打包

This project ships a portable source bundle for another OpenClaw + Obsidian machine.

本项目会生成一个可复制到另一台 OpenClaw + Obsidian 电脑的源码发布包。

## Commands / 命令

```powershell
npm run release:package
npm run release:check
```

The package command writes:

```text
release/okf-obsidian-memory-<version>/
release/okf-obsidian-memory-<version>.zip
```

## Included / 包含

- `src/`: CLI and memory core
- `plugin/`: OpenClaw plugin entries
- `skill/`: OpenClaw skill instructions
- `obsidian/`: Obsidian companion plugin
- `scripts/`: OCR, transcription, Douyin, setup, verification, and release helpers
- `docs/`: install, memory, ontology, OKF, and release docs
- `test/`: regression tests
- `examples/sample-*`: small sample inputs only
- `package.json`, `package-lock.json`, `requirements*.txt`
- `RELEASE_INSTALL.md` and `release-manifest.json`

## Excluded / 排除

- `node_modules`
- `.git`
- `release`
- `examples/vault`
- generated media and local caches
- OpenClaw local config
- API keys and machine-specific secrets

## Verification / 验证

`npm run release:check` validates:

- required files exist
- forbidden paths are absent
- `release-manifest.json` file sizes and SHA-256 hashes match
- release bundle passes `security:check`
- zip file exists, extracts successfully, and passes the same manifest/security checks

For a full local release gate, run:

```powershell
npm run verify:all
```

Before moving the zip to another machine, follow `docs/RELEASE_CHECKLIST.md`.

迁移到另一台电脑前，按 `docs/RELEASE_CHECKLIST.md` 检查。

On a target machine, install dependencies and link OpenClaw:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap_windows.ps1 -Vault <Vault> -InstallMode AUTO -InstallService -NetworkProfile CN
npm run setup:check
npm run verify:plugin
npm run verify:obsidian
npm run verify:obsidian-cli
npm run ui:bilingual
npm run obsidian:views
```

If BGE-M3 and OpenClaw Gateway are already running on the target machine:

```powershell
npm run verify:all
```

If not, start with the offline gate:

```powershell
npm run verify:all -- --skip-embedding --skip-openclaw
```
