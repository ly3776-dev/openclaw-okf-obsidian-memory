# OKF Obsidian Memory — Agent 单文件使用契约

> 这是安装器生成的 Agent 告知文件。用户把本文件交给你，即表示授权你在下述 Vault 范围内执行 OKF 记忆写入、召回、归纳和安全维护。不要要求用户重复提供这里已有的路径或常规配置。

## 已安装环境

- 平台：`{{PLATFORM}}`
- 项目根目录：`{{PROJECT_ROOT}}`
- Obsidian Vault：`{{VAULT_PATH}}`
- 生成时间：`{{GENERATED_AT}}`
- 安装模式：`{{INSTALL_MODE}}`
- 恢复快照：`{{RECOVERY_SNAPSHOT}}`
- OpenClaw 插件：`openclaw-okf-obsidian-memory`
- Embedding：`{{EMBEDDING_DESCRIPTION}}`
- 事实来源：Vault 中的人类可读 Markdown；SQLite、Ontology JSON 和向量文件都只是可重建缓存。

## Agent 必须遵守

1. 每次调用 OKF 工具都使用上面的绝对 Vault 路径，不要猜测其他 Vault。
2. 保存文字或本地文件用 `okf_obsidian_ingest`；抖音链接用 `okf_obsidian_douyin`。
3. 回答历史问题前优先使用 Active Memory；需要显式检索时调用 `okf_obsidian_recall`。
4. 每日或批量整理调用 `okf_obsidian_daily`，随后调用 `okf_obsidian_obsidian_views` 刷新 Canvas/Bases。
5. 新内容需要进入 OpenClaw 长期主动记忆时，调用 `okf_obsidian_okf_export`；如果有终端能力，再运行 `openclaw memory status --index --deep`。
6. 不直接编辑 `<Vault>/.okf-cache`、SQLite、向量二进制或自动生成的 ontology JSON；需要修复时重建缓存。
7. 尊重用户在 Obsidian 中的人工修改、移动和删除。不要把缓存内容反向覆盖 Markdown。
8. 工具返回 `ok: false`、超时或部分失败时，明确报告失败项和修复建议，不得宣称整体成功。
9. Ontology 动作先用 `okf_obsidian_actions_list` 查看；涉及合并、提升或状态变化时先让用户确认，再调用 update/execute。
10. 不把 API key、Gateway token 或其他密钥写进 Vault、聊天回复、日志或本文件。

## 工具路由

| 用户意图 | 首选工具 | 关键参数 |
|---|---|---|
| 记住一段文字 | `okf_obsidian_ingest` | `vault`, `text`, 可选 `title` |
| 导入图片/PDF/音频/视频/文档 | `okf_obsidian_ingest` | `vault`, `inputPath`, `sourceType: auto` |
| 下载并记住抖音 | `okf_obsidian_douyin` | `vault`, `url` |
| 查找相关记忆 | `okf_obsidian_recall` | `vault`, `query`, 可选 `limit` |
| 每日归纳和关系构图 | `okf_obsidian_daily` | `vault` |
| 重建全文缓存 | `okf_obsidian_sqlite_index` | `vault` |
| 校验本体 | `okf_obsidian_ontology_validate` | `vault` |
| 查看建议动作 | `okf_obsidian_actions_list` | `vault`, 可选 `status` |
| 刷新 Obsidian 视图 | `okf_obsidian_obsidian_views` | `vault` |
| 导出给 Active Memory | `okf_obsidian_okf_export` | `vault` |
| 检查 OCR/转录环境 | `okf_obsidian_doctor` | 无参数 |

## 无工具时的终端回退

仅当上述 OpenClaw 工具不可用时，才从项目根目录执行：

```text
node "{{PROJECT_ROOT}}/src/cli.js" ingest --vault "{{VAULT_PATH}}" --text "要保存的内容"
node "{{PROJECT_ROOT}}/src/cli.js" recall --vault "{{VAULT_PATH}}" --query "要查找的主题"
node "{{PROJECT_ROOT}}/src/cli.js" daily --vault "{{VAULT_PATH}}"
node "{{PROJECT_ROOT}}/src/cli.js" okf-export --vault "{{VAULT_PATH}}"
openclaw memory status --index --deep
```

## 正常完成标准

- 新记忆写入 Vault 的 Markdown 文件并返回具体路径。
- 召回结果说明命中的 Markdown 路径，并保留 SQLite、Ontology、Vector 混合召回。
- 每日归纳生成 `daily/YYYY-MM-DD-synthesis.md`。
- Obsidian 视图生成在 `syntheses/`。
- Active Memory 导出生成在 `okf-export/`。
- 任何写入都不得以修改或删除用户原始笔记作为隐含前提。
