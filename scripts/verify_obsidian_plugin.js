#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const manifest = JSON.parse(await readFile("obsidian/manifest.json", "utf8"));
const main = await readFile("obsidian/main.js", "utf8");
const nodeRequire = createRequire(import.meta.url);
const renderedSettingNames = [];
const renderedSettingDescriptions = [];
const renderedButtons = [];
const renderedHeadings = [];

class MockPlugin {
  constructor() {
    this.commands = [];
    this.intervals = [];
    this.settingTabs = [];
  }
  addSettingTab(tab) { this.settingTabs.push(tab); }
  addCommand(command) { this.commands.push(command); }
  registerInterval(interval) { this.intervals.push(interval); }
  loadData() { return {}; }
  saveData() {}
}

class MockPluginSettingTab {
  constructor() {
    this.containerEl = createMockContainer();
  }
}

class MockSetting {
  setName(value) {
    renderedSettingNames.push(String(value));
    return this;
  }
  setDesc(value) {
    renderedSettingDescriptions.push(String(value));
    return this;
  }
  addText(callback) {
    if (callback) callback(createMockTextInput());
    return this;
  }
  addToggle(callback) {
    if (callback) callback(createMockToggle());
    return this;
  }
  addButton(callback) {
    if (callback) callback(createMockButton());
    return this;
  }
  addDropdown(callback) {
    if (callback) callback(createMockDropdown());
    return this;
  }
}

function createMockContainer() {
  return {
    empty() {},
    createEl(_tag, options = {}) {
      if (options.text) renderedHeadings.push(String(options.text));
      return {};
    }
  };
}

function createMockTextInput() {
  return {
    inputEl: {},
    setPlaceholder() { return this; },
    setValue() { return this; },
    onChange() { return this; }
  };
}

function createMockToggle() {
  return {
    setValue() { return this; },
    onChange() { return this; }
  };
}

function createMockButton() {
  return {
    setButtonText(value) {
      renderedButtons.push(String(value));
      return this;
    },
    setCta() { return this; },
    onClick() { return this; }
  };
}

function createMockDropdown() {
  return {
    addOption() { return this; },
    setValue() { return this; },
    onChange() { return this; }
  };
}

function mockRequire(id) {
  if (id === "obsidian") {
    return {
      Notice: class Notice {},
      Plugin: MockPlugin,
      PluginSettingTab: MockPluginSettingTab,
      Setting: MockSetting
    };
  }
  return nodeRequire(id);
}

const module = { exports: {} };
new Function("require", "module", "exports", main)(mockRequire, module, module.exports);
const PluginClass = module.exports;
const pluginInstance = new PluginClass();
const tempDir = await mkdtemp(path.join(os.tmpdir(), "okf-obsidian-plugin-"));
try {
  global.window = { setInterval: () => 1 };
  pluginInstance.app = {
    vault: {
      adapter: {
        getBasePath: () => tempDir
      }
    },
    setting: {
      open() {},
      openTabById() {}
    }
  };
  pluginInstance.manifest = {
    id: manifest.id,
    dir: path.join(tempDir, ".obsidian", "plugins", manifest.id)
  };
  await pluginInstance.onload();
  pluginInstance.settingTabs[0].display();
} finally {
  delete global.window;
  await rm(tempDir, { recursive: true, force: true });
}

const commandNames = pluginInstance.commands.map((command) => command.name).join("\n");
const required = [
  ["manifest id", manifest.id === "okf-obsidian-memory"],
  ["desktop only", manifest.isDesktopOnly === true],
  ["exports plugin class", typeof PluginClass === "function"],
  ["has onload", typeof pluginInstance.onload === "function"],
  ["has scheduler", typeof pluginInstance.maybeRunScheduledDaily === "function"],
  ["daily command", main.includes("run-okf-daily-synthesis")],
  ["OKF validate command", main.includes("validate-strict-okf")],
  ["ontology validate command", main.includes("validate-ontology-graph")],
  ["actions validate command", main.includes("validate-ontology-actions")],
  ["actions open command", main.includes("open-ontology-actions")],
  ["views command", main.includes("refresh-obsidian-ontology-views")],
  ["sqlite index command", main.includes("rebuild-sqlite-memory-index")],
  ["OKF export command", main.includes("export-strict-okf")],
  ["settings command", main.includes("open-okf-memory-settings")],
  ["registerInterval", main.includes("registerInterval")],
  ["onload registered commands", pluginInstance.commands.length >= 6],
  ["daily CLI", main.includes('"daily", "--vault"')],
  ["i18n dictionary", main.includes("const I18N")],
  ["language setting", main.includes('language: "zh"')],
  ["Chinese settings render", renderedSettingNames.includes("项目根目录")],
  ["English dictionary present", main.includes("LLM ontology review")],
  ["language switch render", renderedSettingNames.includes("语言 / Language")],
  ["bilingual command names", commandNames.includes("运行 OKF 每日归纳") && commandNames.includes("Run OKF daily synthesis")],
  ["localized button render", renderedButtons.includes("运行")],
  ["ontology button render", renderedButtons.includes("校验 ontology")],
  ["actions button render", renderedButtons.includes("校验动作")],
  ["open action queue button render", renderedButtons.includes("打开")],
  ["refresh views button render", renderedButtons.includes("刷新")],
  ["sqlite rebuild button render", renderedButtons.includes("重建")],
  ["vault base path", main.includes("getBasePath")],
  ["project root discovery", main.includes("findProjectRoot")],
  ["startup skip without project root", pluginInstance.getProjectRoot() === ""]
];

const failures = required.filter(([, ok]) => !ok).map(([name]) => name);
if (failures.length) {
  console.error(JSON.stringify({
    ok: false,
    failures,
    renderedHeadings,
    renderedSettingNames,
    renderedSettingDescriptions,
    renderedButtons,
    commandNames: pluginInstance.commands.map((command) => command.name)
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  manifest: {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version
  },
  language: pluginInstance.settings.language,
  commands: pluginInstance.commands.map((command) => command.name)
}, null, 2));
