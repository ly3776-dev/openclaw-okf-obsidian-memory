const { Notice, Plugin, PluginSettingTab, Setting } = require("obsidian");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const DEFAULT_SETTINGS = {
  language: "zh",
  projectRoot: "",
  nodePath: "node",
  dailyEnabled: true,
  useLlm: false,
  llmBaseUrl: "",
  llmApiKey: "",
  llmModel: "",
  tavilyApiKey: "",
  embeddingBaseUrl: "",
  embeddingApiKey: "",
  embeddingModel: "",
  dailyHour: 3,
  dailyMinute: 30,
  checkIntervalMinutes: 30,
  lastDailyDate: ""
};

const I18N = {
  en: {
    "command.daily": "Run OKF daily synthesis",
    "command.ontologyValidate": "Validate ontology graph",
    "command.actionsValidate": "Validate ontology actions",
    "command.actionsOpen": "Open ontology action queue",
    "command.views": "Refresh Obsidian ontology views",
    "command.sqliteIndex": "Rebuild SQLite memory index",
    "command.validate": "Validate strict OKF",
    "command.export": "Export strict OKF bundle",
    "command.settings": "Open OKF memory settings",
    "label.validation": "OKF validation",
    "label.ontology": "Ontology validation",
    "label.actions": "Ontology action validation",
    "label.views": "Obsidian views export",
    "label.sqlite": "SQLite memory index",
    "label.export": "OKF export",
    "log.scheduledFailed": "OKF scheduled daily failed",
    "error.desktopAdapter": "OKF Obsidian Memory requires the desktop file-system adapter.",
    "error.projectRoot": "Project root is not configured. Open OKF memory settings and set the folder containing package.json.",
    "error.cliMissing": "OKF CLI not found at {cliPath}. Check the Project root setting.",
    "notice.dailyComplete": "OKF daily synthesis complete: {notePath}",
    "notice.dailyFailed": "OKF daily synthesis failed: {detail}",
    "notice.maintenanceIssues": "{label} completed with issues",
    "notice.maintenanceComplete": "{label} complete",
    "notice.maintenanceFailed": "{label} failed: {detail}",
    "notice.actionsOpenMissing": "Ontology action queue note does not exist yet: {path}",
    "settings.title": "OKF Obsidian Memory",
    "settings.language.name": "Language / 语言",
    "settings.language.desc": "Choose the UI language for settings and notices. Command palette entries stay bilingual.",
    "settings.language.zh": "中文",
    "settings.language.en": "English",
    "settings.projectRoot.name": "Project root",
    "settings.projectRoot.desc": "Folder containing package.json and src/cli.js. Leave blank only when this plugin lives inside the project tree.",
    "settings.nodePath.name": "Node path",
    "settings.nodePath.desc": "Node executable used to run the OKF CLI.",
    "settings.daily.name": "Daily synthesis",
    "settings.daily.desc": "Run OKF synthesis once per day after the configured local time.",
    "settings.llmReview.name": "LLM ontology review",
    "settings.llmReview.desc": "Send the daily ontology graph to the configured OpenAI-compatible LLM or command provider.",
    "settings.llmProvider.name": "LLM provider",
    "settings.llmProvider.desc": "Optional OpenAI-compatible endpoint for daily ontology review. Leave blank to use OS environment variables.",
    "settings.llmApiKey.name": "LLM API key",
    "settings.llmApiKey.desc": "Stored locally in Obsidian plugin data if provided.",
    "settings.tavily.name": "Tavily key",
    "settings.tavily.desc": "Optional web enrichment key for CLI calls launched from Obsidian.",
    "settings.embeddingProvider.name": "Embedding provider",
    "settings.embeddingProvider.desc": "Optional OpenAI-compatible embedding endpoint. Leave blank to use local hashed-token recall.",
    "settings.embeddingApiKey.name": "Embedding API key",
    "settings.embeddingApiKey.desc": "Stored locally in Obsidian plugin data if provided.",
    "settings.dailyTime.name": "Daily time",
    "settings.dailyTime.desc": "Local 24-hour time. Example: 3 and 30 means 03:30.",
    "settings.runNow.name": "Run now",
    "settings.runNow.desc": "Create or refresh today's OKF synthesis note.",
    "settings.ontology.name": "Ontology graph",
    "settings.ontology.desc": "Validate object types, link types, action types, references, and confidence values.",
    "settings.actions.name": "Ontology actions",
    "settings.actions.desc": "Validate the lifecycle queue for suggested ontology maintenance actions.",
    "settings.actionsOpen.name": "Action queue note",
    "settings.actionsOpen.desc": "Open the generated ontology action queue note for review and lifecycle commands.",
    "settings.views.name": "Obsidian views",
    "settings.views.desc": "Refresh ontology.canvas, ontology-actions.base, and action note sources.",
    "settings.sqlite.name": "SQLite memory index",
    "settings.sqlite.desc": "Rebuild the derived SQLite/FTS cache used to speed up large-vault recall.",
    "settings.strictOkf.name": "Strict OKF",
    "settings.strictOkf.desc": "Validate or export a strict OKF bundle from this vault.",
    "button.run": "Run",
    "button.validateOntology": "Validate ontology",
    "button.validateActions": "Validate actions",
    "button.open": "Open",
    "button.refresh": "Refresh",
    "button.rebuild": "Rebuild",
    "button.validate": "Validate",
    "button.export": "Export"
  },
  zh: {
    "command.daily": "运行 OKF 每日归纳",
    "command.ontologyValidate": "校验 Ontology 图",
    "command.actionsValidate": "校验 Ontology 动作队列",
    "command.actionsOpen": "打开 Ontology 动作队列",
    "command.views": "刷新 Obsidian Ontology 视图",
    "command.sqliteIndex": "重建 SQLite 记忆索引",
    "command.validate": "校验严格 OKF",
    "command.export": "导出严格 OKF 包",
    "command.settings": "打开 OKF 记忆设置",
    "label.validation": "OKF 校验",
    "label.ontology": "Ontology 校验",
    "label.actions": "Ontology 动作校验",
    "label.views": "Obsidian 视图导出",
    "label.sqlite": "SQLite 记忆索引",
    "label.export": "OKF 导出",
    "log.scheduledFailed": "OKF 定时每日归纳失败",
    "error.desktopAdapter": "OKF Obsidian Memory 需要 Obsidian 桌面端文件系统适配器。",
    "error.projectRoot": "还没有配置项目根目录。请打开 OKF 记忆设置，并设置包含 package.json 的项目文件夹。",
    "error.cliMissing": "没有在 {cliPath} 找到 OKF CLI。请检查项目根目录设置。",
    "notice.dailyComplete": "OKF 每日归纳已完成：{notePath}",
    "notice.dailyFailed": "OKF 每日归纳失败：{detail}",
    "notice.maintenanceIssues": "{label} 已完成，但发现问题",
    "notice.maintenanceComplete": "{label} 已完成",
    "notice.maintenanceFailed": "{label} 失败：{detail}",
    "notice.actionsOpenMissing": "还没有生成 Ontology 动作队列笔记：{path}",
    "settings.title": "OKF Obsidian 记忆",
    "settings.language.name": "语言 / Language",
    "settings.language.desc": "选择设置页和通知使用的语言。命令面板会保持中英文双语显示。",
    "settings.language.zh": "中文",
    "settings.language.en": "English",
    "settings.projectRoot.name": "项目根目录",
    "settings.projectRoot.desc": "包含 package.json 和 src/cli.js 的文件夹。只有当插件位于项目目录内时才可以留空。",
    "settings.nodePath.name": "Node 路径",
    "settings.nodePath.desc": "用于运行 OKF CLI 的 Node 可执行文件。",
    "settings.daily.name": "每日归纳",
    "settings.daily.desc": "每天在配置的本地时间之后运行一次 OKF 归纳。",
    "settings.llmReview.name": "LLM 本体复核",
    "settings.llmReview.desc": "把每日 ontology 图发送给已配置的 OpenAI 兼容 LLM 或命令提供器。",
    "settings.llmProvider.name": "LLM 提供器",
    "settings.llmProvider.desc": "用于每日 ontology 复核的可选 OpenAI 兼容端点。留空则使用系统环境变量。",
    "settings.llmApiKey.name": "LLM API 密钥",
    "settings.llmApiKey.desc": "如果填写，会保存在本地 Obsidian 插件数据中。",
    "settings.tavily.name": "Tavily 密钥",
    "settings.tavily.desc": "从 Obsidian 发起 CLI 调用时，用于联网补全的可选密钥。",
    "settings.embeddingProvider.name": "Embedding 提供器",
    "settings.embeddingProvider.desc": "可选的 OpenAI 兼容 embedding 端点。留空则使用本地 hashed-token 召回。",
    "settings.embeddingApiKey.name": "Embedding API 密钥",
    "settings.embeddingApiKey.desc": "如果填写，会保存在本地 Obsidian 插件数据中。",
    "settings.dailyTime.name": "每日时间",
    "settings.dailyTime.desc": "本地 24 小时时间。例如 3 和 30 表示 03:30。",
    "settings.runNow.name": "立即运行",
    "settings.runNow.desc": "创建或刷新今天的 OKF 归纳笔记。",
    "settings.ontology.name": "Ontology 图",
    "settings.ontology.desc": "校验对象类型、关系类型、动作类型、引用和置信度。",
    "settings.actions.name": "Ontology 动作",
    "settings.actions.desc": "校验 ontology 维护建议的生命周期队列。",
    "settings.actionsOpen.name": "动作队列笔记",
    "settings.actionsOpen.desc": "打开已生成的 ontology 动作队列笔记，用于复核和查看生命周期命令。",
    "settings.views.name": "Obsidian 视图",
    "settings.views.desc": "刷新 ontology.canvas、ontology-actions.base 和动作笔记数据源。",
    "settings.sqlite.name": "SQLite 记忆索引",
    "settings.sqlite.desc": "重建派生 SQLite/FTS 缓存，用于加速大 vault 召回。",
    "settings.strictOkf.name": "严格 OKF",
    "settings.strictOkf.desc": "校验或导出当前 vault 的严格 OKF 包。",
    "button.run": "运行",
    "button.validateOntology": "校验 ontology",
    "button.validateActions": "校验动作",
    "button.open": "打开",
    "button.refresh": "刷新",
    "button.rebuild": "重建",
    "button.validate": "校验",
    "button.export": "导出"
  }
};

module.exports = class OkfObsidianMemoryPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.language = normalizeLanguage(this.settings.language);
    this.addSettingTab(new OkfSettingTab(this.app, this));

    this.addCommand({
      id: "run-okf-daily-synthesis",
      name: this.commandName("command.daily"),
      callback: () => this.runDailySynthesis({ manual: true })
    });

    this.addCommand({
      id: "validate-strict-okf",
      name: this.commandName("command.validate"),
      callback: () => this.runOkfMaintenance("okf-validate", "label.validation")
    });

    this.addCommand({
      id: "validate-ontology-graph",
      name: this.commandName("command.ontologyValidate"),
      callback: () => this.runOkfMaintenance("ontology-validate", "label.ontology")
    });

    this.addCommand({
      id: "validate-ontology-actions",
      name: this.commandName("command.actionsValidate"),
      callback: () => this.runOkfMaintenance("action-validate", "label.actions")
    });

    this.addCommand({
      id: "open-ontology-actions",
      name: this.commandName("command.actionsOpen"),
      callback: () => this.openActionQueueNote()
    });

    this.addCommand({
      id: "refresh-obsidian-ontology-views",
      name: this.commandName("command.views"),
      callback: () => this.runOkfMaintenance("obsidian-views", "label.views")
    });

    this.addCommand({
      id: "rebuild-sqlite-memory-index",
      name: this.commandName("command.sqliteIndex"),
      callback: () => this.runOkfMaintenance("sqlite-index", "label.sqlite")
    });

    this.addCommand({
      id: "export-strict-okf",
      name: this.commandName("command.export"),
      callback: () => this.runOkfMaintenance("okf-export", "label.export")
    });

    this.addCommand({
      id: "open-okf-memory-settings",
      name: this.commandName("command.settings"),
      callback: () => {
        this.app.setting.open();
        this.app.setting.openTabById(this.manifest.id);
      }
    });

    this.registerInterval(
      window.setInterval(
        () => {
          void this.maybeRunScheduledDaily().catch((error) => {
            console.error(this.t("log.scheduledFailed"), error);
          });
        },
        Math.max(1, Number(this.settings.checkIntervalMinutes) || 30) * 60 * 1000
      )
    );

    void this.maybeRunScheduledDaily().catch((error) => {
      console.error(this.t("log.scheduledFailed"), error);
    });
  }

  t(key, vars = {}) {
    return translate(this.settings, key, vars);
  }

  commandName(key) {
    return bilingualText(this.settings, key);
  }

  async saveSettings() {
    this.settings.language = normalizeLanguage(this.settings.language);
    await this.saveData(this.settings);
  }

  getVaultPath() {
    const adapter = this.app.vault.adapter;
    if (typeof adapter.getBasePath === "function") {
      return adapter.getBasePath();
    }
    throw new Error(this.t("error.desktopAdapter"));
  }

  getProjectRoot() {
    const configured = String(this.settings.projectRoot || "").trim();
    if (configured) return configured;
    const discovered = findProjectRoot(this.manifest.dir || "");
    return discovered || "";
  }

  getCliPath() {
    const root = this.getProjectRoot();
    if (!root) {
      throw new Error(this.t("error.projectRoot"));
    }
    const cliPath = path.join(root, "src", "cli.js");
    if (!fs.existsSync(cliPath)) {
      throw new Error(this.t("error.cliMissing", { cliPath }));
    }
    return cliPath;
  }

  runOkfCli(args) {
    return new Promise((resolve, reject) => {
      execFile(this.settings.nodePath || "node", [this.getCliPath(), ...args], {
        cwd: this.getProjectRoot(),
        env: this.buildCliEnv(),
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024
      }, (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  buildCliEnv() {
    const env = { ...process.env };
    setIfPresent(env, "OKF_LLM_BASE_URL", this.settings.llmBaseUrl);
    setIfPresent(env, "OKF_LLM_API_KEY", this.settings.llmApiKey);
    setIfPresent(env, "OKF_LLM_MODEL", this.settings.llmModel);
    setIfPresent(env, "OKF_TAVILY_API_KEY", this.settings.tavilyApiKey);
    setIfPresent(env, "OKF_EMBEDDING_BASE_URL", this.settings.embeddingBaseUrl);
    setIfPresent(env, "OKF_EMBEDDING_API_KEY", this.settings.embeddingApiKey);
    setIfPresent(env, "OKF_EMBEDDING_MODEL", this.settings.embeddingModel);
    return env;
  }

  async runDailySynthesis({ manual = false } = {}) {
    try {
      const args = ["daily", "--vault", this.getVaultPath()];
      if (this.settings.useLlm) args.push("--use-llm");
      const result = await this.runOkfCli(args);
      const parsed = parseJsonOutput(result.stdout);
      const notePath = parsed && parsed.filePath ? path.basename(parsed.filePath) : "daily synthesis";
      new Notice(this.t("notice.dailyComplete", { notePath }));
      this.settings.lastDailyDate = localDateKey();
      await this.saveSettings();
      return parsed || result;
    } catch (error) {
      const detail = error.stderr || error.stdout || error.message;
      new Notice(this.t("notice.dailyFailed", { detail: String(detail).slice(0, 240) }));
      if (manual) console.error(error);
      throw error;
    }
  }

  async runOkfMaintenance(command, labelKey) {
    const label = this.t(labelKey);
    try {
      const result = await this.runOkfCli([command, "--vault", this.getVaultPath()]);
      const parsed = parseJsonOutput(result.stdout);
      if (parsed && parsed.ok === false) {
        new Notice(this.t("notice.maintenanceIssues", { label }));
      } else {
        new Notice(this.t("notice.maintenanceComplete", { label }));
      }
      return parsed || result;
    } catch (error) {
      const detail = error.stderr || error.stdout || error.message;
      new Notice(this.t("notice.maintenanceFailed", { label, detail: String(detail).slice(0, 240) }));
      throw error;
    }
  }

  async openActionQueueNote() {
    const notePath = "syntheses/ontology-actions.md";
    const file = this.app.vault.getAbstractFileByPath && this.app.vault.getAbstractFileByPath(notePath);
    if (!file) {
      new Notice(this.t("notice.actionsOpenMissing", { path: notePath }));
      return null;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
    return file;
  }

  async maybeRunScheduledDaily() {
    if (!this.settings.dailyEnabled) return;
    if (!this.getProjectRoot()) return;
    const now = new Date();
    const today = localDateKey(now);
    if (this.settings.lastDailyDate === today) return;

    const hour = clampInt(this.settings.dailyHour, 0, 23, DEFAULT_SETTINGS.dailyHour);
    const minute = clampInt(this.settings.dailyMinute, 0, 59, DEFAULT_SETTINGS.dailyMinute);
    const scheduled = new Date(now);
    scheduled.setHours(hour, minute, 0, 0);
    if (now < scheduled) return;

    await this.runDailySynthesis({ manual: false });
  }
};

class OkfSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const t = (key, vars) => this.plugin.t(key, vars);
    containerEl.empty();
    containerEl.createEl("h2", { text: t("settings.title") });

    const languageSetting = new Setting(containerEl)
      .setName(t("settings.language.name"))
      .setDesc(t("settings.language.desc"));
    if (typeof languageSetting.addDropdown === "function") {
      languageSetting.addDropdown((dropdown) => dropdown
        .addOption("zh", t("settings.language.zh"))
        .addOption("en", t("settings.language.en"))
        .setValue(normalizeLanguage(this.plugin.settings.language))
        .onChange(async (value) => {
          this.plugin.settings.language = normalizeLanguage(value);
          await this.plugin.saveSettings();
          this.display();
        }));
    } else {
      languageSetting.addText((text) => text
        .setPlaceholder("zh / en")
        .setValue(normalizeLanguage(this.plugin.settings.language))
        .onChange(async (value) => {
          this.plugin.settings.language = normalizeLanguage(value);
          await this.plugin.saveSettings();
          this.display();
        }));
    }

    new Setting(containerEl)
      .setName(t("settings.projectRoot.name"))
      .setDesc(t("settings.projectRoot.desc"))
      .addText((text) => text
        .setPlaceholder("E:\\codex项目\\op_okf_obsidian")
        .setValue(this.plugin.settings.projectRoot)
        .onChange(async (value) => {
          this.plugin.settings.projectRoot = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("settings.nodePath.name"))
      .setDesc(t("settings.nodePath.desc"))
      .addText((text) => text
        .setPlaceholder("node")
        .setValue(this.plugin.settings.nodePath)
        .onChange(async (value) => {
          this.plugin.settings.nodePath = value.trim() || "node";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("settings.daily.name"))
      .setDesc(t("settings.daily.desc"))
      .addToggle((toggle) => toggle
        .setValue(Boolean(this.plugin.settings.dailyEnabled))
        .onChange(async (value) => {
          this.plugin.settings.dailyEnabled = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("settings.llmReview.name"))
      .setDesc(t("settings.llmReview.desc"))
      .addToggle((toggle) => toggle
        .setValue(Boolean(this.plugin.settings.useLlm))
        .onChange(async (value) => {
          this.plugin.settings.useLlm = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("settings.llmProvider.name"))
      .setDesc(t("settings.llmProvider.desc"))
      .addText((text) => text
        .setPlaceholder("https://your-gateway.example")
        .setValue(this.plugin.settings.llmBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.llmBaseUrl = value.trim();
          await this.plugin.saveSettings();
        }))
      .addText((text) => text
        .setPlaceholder("model")
        .setValue(this.plugin.settings.llmModel)
        .onChange(async (value) => {
          this.plugin.settings.llmModel = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("settings.llmApiKey.name"))
      .setDesc(t("settings.llmApiKey.desc"))
      .addText((text) => {
        if (text.inputEl) text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.llmApiKey)
          .onChange(async (value) => {
            this.plugin.settings.llmApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("settings.tavily.name"))
      .setDesc(t("settings.tavily.desc"))
      .addText((text) => {
        if (text.inputEl) text.inputEl.type = "password";
        text
          .setPlaceholder("tvly-...")
          .setValue(this.plugin.settings.tavilyApiKey)
          .onChange(async (value) => {
            this.plugin.settings.tavilyApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("settings.embeddingProvider.name"))
      .setDesc(t("settings.embeddingProvider.desc"))
      .addText((text) => text
        .setPlaceholder("https://your-gateway.example")
        .setValue(this.plugin.settings.embeddingBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.embeddingBaseUrl = value.trim();
          await this.plugin.saveSettings();
        }))
      .addText((text) => text
        .setPlaceholder("embedding-model")
        .setValue(this.plugin.settings.embeddingModel)
        .onChange(async (value) => {
          this.plugin.settings.embeddingModel = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("settings.embeddingApiKey.name"))
      .setDesc(t("settings.embeddingApiKey.desc"))
      .addText((text) => {
        if (text.inputEl) text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.embeddingApiKey)
          .onChange(async (value) => {
            this.plugin.settings.embeddingApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("settings.dailyTime.name"))
      .setDesc(t("settings.dailyTime.desc"))
      .addText((text) => text
        .setPlaceholder("3")
        .setValue(String(this.plugin.settings.dailyHour))
        .onChange(async (value) => {
          this.plugin.settings.dailyHour = clampInt(value, 0, 23, DEFAULT_SETTINGS.dailyHour);
          await this.plugin.saveSettings();
        }))
      .addText((text) => text
        .setPlaceholder("30")
        .setValue(String(this.plugin.settings.dailyMinute))
        .onChange(async (value) => {
          this.plugin.settings.dailyMinute = clampInt(value, 0, 59, DEFAULT_SETTINGS.dailyMinute);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("settings.runNow.name"))
      .setDesc(t("settings.runNow.desc"))
      .addButton((button) => button
        .setButtonText(t("button.run"))
        .setCta()
        .onClick(() => this.plugin.runDailySynthesis({ manual: true })));

    new Setting(containerEl)
      .setName(t("settings.ontology.name"))
      .setDesc(t("settings.ontology.desc"))
      .addButton((button) => button
        .setButtonText(t("button.validateOntology"))
        .onClick(() => this.plugin.runOkfMaintenance("ontology-validate", "label.ontology")));

    new Setting(containerEl)
      .setName(t("settings.actions.name"))
      .setDesc(t("settings.actions.desc"))
      .addButton((button) => button
        .setButtonText(t("button.validateActions"))
        .onClick(() => this.plugin.runOkfMaintenance("action-validate", "label.actions")));

    new Setting(containerEl)
      .setName(t("settings.actionsOpen.name"))
      .setDesc(t("settings.actionsOpen.desc"))
      .addButton((button) => button
        .setButtonText(t("button.open"))
        .onClick(() => this.plugin.openActionQueueNote()));

    new Setting(containerEl)
      .setName(t("settings.views.name"))
      .setDesc(t("settings.views.desc"))
      .addButton((button) => button
        .setButtonText(t("button.refresh"))
        .onClick(() => this.plugin.runOkfMaintenance("obsidian-views", "label.views")));

    new Setting(containerEl)
      .setName(t("settings.sqlite.name"))
      .setDesc(t("settings.sqlite.desc"))
      .addButton((button) => button
        .setButtonText(t("button.rebuild"))
        .onClick(() => this.plugin.runOkfMaintenance("sqlite-index", "label.sqlite")));

    new Setting(containerEl)
      .setName(t("settings.strictOkf.name"))
      .setDesc(t("settings.strictOkf.desc"))
      .addButton((button) => button
        .setButtonText(t("button.validate"))
        .onClick(() => this.plugin.runOkfMaintenance("okf-validate", "label.validation")))
      .addButton((button) => button
        .setButtonText(t("button.export"))
        .onClick(() => this.plugin.runOkfMaintenance("okf-export", "label.export")));
  }
}

function translate(settings, key, vars = {}) {
  const language = normalizeLanguage(settings && settings.language);
  const dictionary = I18N[language] || I18N.zh;
  const template = dictionary[key] || I18N.en[key] || key;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => String(vars[name] ?? ""));
}

function bilingualText(settings, key) {
  const language = normalizeLanguage(settings && settings.language);
  const alternate = language === "zh" ? "en" : "zh";
  const primary = translate({ language }, key);
  const secondary = translate({ language: alternate }, key);
  if (primary === secondary) return primary;
  return `${primary} / ${secondary}`;
}

function normalizeLanguage(value) {
  return value === "en" ? "en" : "zh";
}

function parseJsonOutput(stdout) {
  try {
    return JSON.parse(String(stdout || "").trim());
  } catch {
    return null;
  }
}

function clampInt(value, min, max, fallback) {
  const next = Number.parseInt(String(value), 10);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, next));
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function setIfPresent(env, key, value) {
  const text = String(value || "").trim();
  if (text) env[key] = text;
}

function findProjectRoot(startDir) {
  let current = startDir ? path.resolve(startDir) : "";
  for (let i = 0; current && i < 10; i += 1) {
    if (
      fs.existsSync(path.join(current, "package.json")) &&
      fs.existsSync(path.join(current, "src", "cli.js"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return "";
}
