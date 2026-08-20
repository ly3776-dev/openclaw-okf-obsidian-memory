# Obsidian Skills Integration / Obsidian Skills 集成

Obsidian's official skills are useful for the Obsidian-native layer of this project. They do not replace the OKF memory core, OpenClaw tools, OCR/transcription, Douyin download, vector recall, or ontology pipeline.

Obsidian 官方 skills 对本项目的 Obsidian 原生层很有帮助，但不会替代 OKF 记忆核心、OpenClaw 工具、OCR/转写、抖音下载、向量召回或 ontology 流水线。

## What We Use / 我们使用什么

- Obsidian CLI verification: optional GUI-facing plugin reload, command inspection, error inspection, and screenshot checks.
- Obsidian Markdown conventions: safer properties, links, and view notes inside the vault.
- JSON Canvas: ontology graph exported as `syntheses/ontology.canvas`.
- Bases: ontology actions exported as `syntheses/ontology-actions.base`, backed by generated action notes in `syntheses/ontology-action-notes/`.

## Enable Obsidian CLI / 启用 Obsidian CLI

Obsidian CLI requires Obsidian 1.12 or newer. In Obsidian, open:

```text
Settings -> General -> Command line interface
```

Then reopen the terminal and verify:

```powershell
obsidian --version
npm run verify:obsidian-cli
```

If `obsidian` is not on `PATH`, `npm run verify:obsidian-cli` exits successfully with `skipped: true` and prints setup instructions.

如果 `obsidian` 不在 `PATH` 中，`npm run verify:obsidian-cli` 会以 `skipped: true` 成功退出，并输出设置提示。

## Generated Views / 生成的视图

Refresh views with:

```powershell
npm run obsidian:views
```

Or from Obsidian:

```text
刷新 Obsidian Ontology 视图 / Refresh Obsidian ontology views
重建 SQLite 记忆索引 / Rebuild SQLite memory index
```

Generated files:

- `syntheses/ontology.canvas`: JSON Canvas graph of Concept, Entity, Source, and Tag objects.
- `syntheses/ontology-actions.base`: Bases table view for action lifecycle review.
- `syntheses/ontology-action-notes/*.md`: one note per ontology action, with status/type/priority/confidence properties.

## Verification / 验证

The full gate includes:

```powershell
npm run verify:obsidian
npm run verify:obsidian-cli
npm run obsidian:views
npm run sqlite:index
npm run ui:bilingual
```

`verify:all` also runs these steps. The CLI step remains optional so headless or non-GUI machines can still pass release checks.

`verify:all` 也会运行这些步骤。CLI 步骤保持可选，因此无 GUI 或未启用 Obsidian CLI 的机器仍可通过发布检查。
