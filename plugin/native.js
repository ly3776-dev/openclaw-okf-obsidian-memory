import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import path from "node:path";
import { actionQueueExecute, actionQueueList, actionQueueUpdate, actionQueueValidate, daily, ingest, obsidianViewsExport, okfExport, okfValidate, ontologyValidate, recall, sqliteIndexRebuild } from "../src/core.js";
import { downloadDouyin } from "../src/douyin.js";
import { runExtractorDoctor } from "../src/extract.js";

const VaultPath = Type.String({
  description: "Obsidian vault folder path / Obsidian vault 文件夹路径。"
});

const IngestParams = Type.Object({
  vault: VaultPath,
  text: Type.Optional(Type.String({ description: "Inline text to capture / 要沉淀的内联文本。" })),
  inputPath: Type.Optional(Type.String({ description: "Local file path to ingest / 要导入的本地文件路径。" })),
  sourceType: Type.Optional(Type.String({ description: "Input type; use auto unless known / 输入类型，不确定时使用 auto。" })),
  title: Type.Optional(Type.String({ description: "Optional note title override / 可选的笔记标题覆盖。" })),
  useWeb: Type.Optional(Type.Boolean({ description: "Run optional web enrichment / 是否启用可选联网补全。" }))
}, { additionalProperties: false });

const DailyParams = Type.Object({
  vault: VaultPath,
  useLlm: Type.Optional(Type.Boolean({ description: "Run optional LLM ontology review / 是否启用可选 LLM ontology 复核。" }))
}, { additionalProperties: false });

const RecallParams = Type.Object({
  vault: VaultPath,
  query: Type.String({ description: "Search query for related OKF notes / 召回相关 OKF 笔记的查询。" }),
  limit: Type.Optional(Type.Number({ description: "Maximum matches to return / 最大返回条数。", minimum: 1, maximum: 20 }))
}, { additionalProperties: false });

const SqliteIndexParams = Type.Object({
  vault: VaultPath
}, { additionalProperties: false });

const DouyinParams = Type.Object({
  vault: VaultPath,
  url: Type.Optional(Type.String({ description: "Douyin URL or share text / 抖音链接或分享文本。" })),
  text: Type.Optional(Type.String({ description: "Douyin share text containing a URL / 含链接的抖音分享文本。" })),
  input: Type.Optional(Type.String({ description: "Alias for url/text / url 或 text 的脚本调用别名。" })),
  outputDir: Type.Optional(Type.String({ description: "Optional directory for downloaded MP4 files / 可选 MP4 下载目录。" })),
  title: Type.Optional(Type.String({ description: "Optional note title override / 可选的笔记标题覆盖。" }))
}, { additionalProperties: false });

const DoctorParams = Type.Object({}, { additionalProperties: false });

const OkfValidateParams = Type.Object({
  vault: VaultPath
}, { additionalProperties: false });

const OntologyValidateParams = Type.Object({
  vault: VaultPath
}, { additionalProperties: false });

const ActionsValidateParams = Type.Object({
  vault: VaultPath
}, { additionalProperties: false });

const ActionsListParams = Type.Object({
  vault: VaultPath,
  status: Type.Optional(Type.String({ description: "Optional status filter such as proposed, accepted, in_progress, done, dismissed, or archived / 可选状态过滤，例如 proposed、accepted、in_progress、done、dismissed 或 archived。" })),
  limit: Type.Optional(Type.Number({ description: "Maximum actions to return / 最大返回动作数。", minimum: 1, maximum: 100 }))
}, { additionalProperties: false });

const ActionUpdateParams = Type.Object({
  vault: VaultPath,
  id: Type.String({ description: "Action id from the ontology action queue / ontology 动作队列中的动作 ID。" }),
  status: Type.String({ description: "New status: proposed, accepted, in_progress, done, dismissed, or archived / 新状态：proposed、accepted、in_progress、done、dismissed 或 archived。" }),
  note: Type.Optional(Type.String({ description: "Optional lifecycle note for audit history / 可选生命周期备注，用于审计历史。" }))
}, { additionalProperties: false });

const ActionExecuteParams = Type.Object({
  vault: VaultPath,
  id: Type.String({ description: "Action id to execute from the ontology action queue / 要执行的 ontology 动作队列 ID。" })
}, { additionalProperties: false });

const ObsidianViewsParams = Type.Object({
  vault: VaultPath
}, { additionalProperties: false });

const OkfExportParams = Type.Object({
  vault: VaultPath,
  outputDir: Type.Optional(Type.String({ description: "Optional output directory for the strict OKF bundle / 严格 OKF 包的可选导出目录。" }))
}, { additionalProperties: false });

export default defineToolPlugin({
  id: "openclaw-okf-obsidian-memory",
  name: "OKF Obsidian Memory / OKF Obsidian 记忆",
  description: "Capture multimodal inputs as OKF notes in an Obsidian vault, including Douyin videos. / 把多模态内容沉淀为 Obsidian vault 中的 OKF 笔记，支持抖音视频。",
  activation: {
    onStartup: true,
    capabilities: ["tool"]
  },
  tools: (tool) => [
    tool({
      name: "okf_obsidian_ingest",
      label: "Ingest OKF Note / 写入 OKF 笔记",
      description: "Convert inline text or a local file into an OKF Markdown note and write it to an Obsidian vault. / 把文本或本地文件转换为 OKF Markdown 笔记并写入 Obsidian vault。",
      parameters: IngestParams,
      execute: async (params) => ingest(params)
    }),
    tool({
      name: "okf_obsidian_daily",
      label: "Run OKF Daily Synthesis / 运行 OKF 每日归纳",
      description: "Run ontology-aware daily linking and synthesis over OKF notes in an Obsidian vault. / 对 Obsidian vault 中的 OKF 笔记执行 ontology 感知的每日关联和归纳。",
      parameters: DailyParams,
      execute: async (params) => daily(params)
    }),
    tool({
      name: "okf_obsidian_recall",
      label: "Recall OKF Notes / 召回 OKF 笔记",
      description: "Recall related OKF notes from an Obsidian vault using lexical, SQLite, ontology, and vector signals. / 根据查询用词法、SQLite、ontology 和向量信号从 Obsidian vault 召回相关 OKF 笔记。",
      parameters: RecallParams,
      execute: async (params) => recall(params)
    }),
    tool({
      name: "okf_obsidian_sqlite_index",
      label: "Rebuild SQLite Memory Index / 重建 SQLite 记忆索引",
      description: "Rebuild the derived SQLite/FTS memory index for faster large-vault recall while keeping Markdown as the source of truth. / 重建派生 SQLite/FTS 记忆索引，加速大 vault 召回，同时 Markdown 仍是事实来源。",
      parameters: SqliteIndexParams,
      execute: async (params) => sqliteIndexRebuild(params)
    }),
    tool({
      name: "okf_obsidian_douyin",
      label: "Capture Douyin Video / 沉淀抖音视频",
      description: "Download a Douyin video, transcribe it, and write it as an OKF Markdown note in an Obsidian vault. / 下载抖音视频、转写内容，并写入 Obsidian vault 的 OKF Markdown 笔记。",
      parameters: DouyinParams,
      execute: async (params) => {
        const outputDir = params.outputDir || path.join(params.vault || ".", "media", "douyin");
        const downloaded = await downloadDouyin({
          input: params.url || params.text || params.input,
          outputDir
        });
        const result = await ingest({
          vault: params.vault,
          inputPath: downloaded.filePath,
          sourceType: "video",
          title: params.title
        });
        return { ...result, downloaded };
      }
    }),
    tool({
      name: "okf_obsidian_doctor",
      label: "Check OKF Obsidian Extractors / 检查 OKF 提取器",
      description: "Check local extractor availability, including MarkItDown, PaddleOCR, FunASR, and faster-whisper. / 检查本地提取器可用性，包括 MarkItDown、PaddleOCR、FunASR 和 faster-whisper。",
      parameters: DoctorParams,
      execute: async () => runExtractorDoctor()
    }),
    tool({
      name: "okf_obsidian_okf_validate",
      label: "Validate Strict OKF / 校验严格 OKF",
      description: "Validate concept notes against the strict OKF v0.1 constraints used by this project. / 按本项目使用的严格 OKF v0.1 约束校验概念笔记。",
      parameters: OkfValidateParams,
      execute: async (params) => okfValidate(params)
    }),
    tool({
      name: "okf_obsidian_ontology_validate",
      label: "Validate Ontology Graph / 校验 Ontology 图",
      description: "Validate the Palantir-style ontology graph schema, object types, link types, action types, references, and confidence values. / 校验 Palantir 风格 ontology 图的 schema、对象类型、关系类型、动作类型、引用和置信度。",
      parameters: OntologyValidateParams,
      execute: async (params) => ontologyValidate(params)
    }),
    tool({
      name: "okf_obsidian_actions_validate",
      label: "Validate Ontology Actions / 校验 Ontology 动作队列",
      description: "Validate the lifecycle action queue generated from ontology actions, including status, priority, references, and stale action handling. / 校验由 ontology actions 生成的生命周期动作队列，包括状态、优先级、引用和过期动作处理。",
      parameters: ActionsValidateParams,
      execute: async (params) => actionQueueValidate(params)
    }),
    tool({
      name: "okf_obsidian_actions_list",
      label: "List Ontology Actions / 列出 Ontology 动作",
      description: "List suggested ontology lifecycle actions so OpenClaw can decide what to accept, start, complete, dismiss, or archive. / 列出建议的 ontology 生命周期动作，方便 OpenClaw 决定接受、开始、完成、忽略或归档。",
      parameters: ActionsListParams,
      execute: async (params) => actionQueueList(params)
    }),
    tool({
      name: "okf_obsidian_action_update",
      label: "Update Ontology Action / 更新 Ontology 动作",
      description: "Update one ontology action status and append an audit note to its lifecycle history. / 更新单条 ontology 动作状态，并把备注写入生命周期审计历史。",
      parameters: ActionUpdateParams,
      execute: async (params) => actionQueueUpdate(params)
    }),
    tool({
      name: "okf_obsidian_action_execute",
      label: "Execute Ontology Action / 执行 Ontology 动作",
      description: "Create a safe lifecycle artifact for one ontology action, such as an entity note or review note, and advance its status. / 为单条 ontology 动作创建安全的生命周期产物，例如实体笔记或复核笔记，并推进其状态。",
      parameters: ActionExecuteParams,
      execute: async (params) => actionQueueExecute(params)
    }),
    tool({
      name: "okf_obsidian_obsidian_views",
      label: "Export Obsidian Views / 导出 Obsidian 视图",
      description: "Refresh Obsidian-native ontology Canvas and Bases views for the vault. / 刷新 vault 中的 Obsidian 原生 ontology Canvas 和 Bases 视图。",
      parameters: ObsidianViewsParams,
      execute: async (params) => obsidianViewsExport(params)
    }),
    tool({
      name: "okf_obsidian_okf_export",
      label: "Export Strict OKF / 导出严格 OKF",
      description: "Export concept notes into a strict OKF v0.1 Markdown bundle. / 把概念笔记导出为严格 OKF v0.1 Markdown 包。",
      parameters: OkfExportParams,
      execute: async (params) => okfExport(params)
    })
  ]
});
