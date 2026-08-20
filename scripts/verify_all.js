#!/usr/bin/env node
import { spawn } from "node:child_process";

const args = new Set(process.argv.slice(2));
const npm = "npm";
const steps = [
  { name: "unit tests / 单元测试", command: npm, args: ["test"] },
  { name: "easy installer verification / 简易安装器验证", command: npm, args: ["run", "verify:installers"] },
  { name: "Linux shell syntax / Linux Shell 语法", command: npm, args: ["run", "verify:shell"] },
  { name: "OpenClaw plugin verification / OpenClaw 插件验证", command: npm, args: ["run", "verify:plugin"] },
  { name: "Obsidian plugin verification / Obsidian 插件验证", command: npm, args: ["run", "verify:obsidian"] },
  { name: "bilingual UI verification / 双语界面验证", command: npm, args: ["run", "ui:bilingual"] },
  { name: "release secret scan / 发布密钥扫描", command: npm, args: ["run", "security:check"] },
  { name: "ontology graph validation / Ontology 图校验", command: npm, args: ["run", "ontology:validate"] },
  { name: "ontology action queue validation / Ontology 动作队列校验", command: npm, args: ["run", "actions:validate"] },
  { name: "ontology action queue list / Ontology 动作队列列表", command: npm, args: ["run", "actions:list"] },
  { name: "Obsidian Canvas/Base export / Obsidian Canvas/Base 导出", command: npm, args: ["run", "obsidian:views"] },
  { name: "SQLite recall index rebuild / SQLite 召回索引重建", command: npm, args: ["run", "sqlite:index"] },
  { name: "strict OKF validation / 严格 OKF 校验", command: npm, args: ["run", "okf:validate"] },
  { name: "strict OKF export / 严格 OKF 导出", command: npm, args: ["run", "okf:export"] },
  { name: "release package / 发布包生成", command: npm, args: ["run", "release:package"] },
  { name: "release package check / 发布包校验", command: npm, args: ["run", "release:check"] }
];

if (!args.has("--skip-obsidian-cli")) {
  steps.splice(5, 0, { name: "Obsidian CLI verification / Obsidian CLI 验证", command: npm, args: ["run", "verify:obsidian-cli"] });
}

if (!args.has("--skip-embedding")) {
  steps.push({ name: "embedding endpoint health / 向量端点健康检查", command: npm, args: ["run", "embedding:health"] });
  steps.push({ name: "recall quality evaluation / 召回质量评测", command: npm, args: ["run", "recall:quality"] });
}

if (!args.has("--skip-openclaw")) {
  steps.push({ name: "OpenClaw active-memory closed loop / OpenClaw 主动记忆闭环", command: npm, args: ["run", "verify:openclaw"] });
}

const startedAt = Date.now();
const completed = [];

try {
  for (const step of steps) {
    const stepStartedAt = Date.now();
    console.log(`\n[verify:all] ${step.name}`);
    await run(step.command, step.args);
    completed.push({
      name: step.name,
      seconds: Number(((Date.now() - stepStartedAt) / 1000).toFixed(1))
    });
  }

  console.log(JSON.stringify({
    ok: true,
    completed,
    totalSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1))
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    completed,
    failed: error.step || null,
    message: error.message
  }, null, 2));
  process.exitCode = 1;
}

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const launch = makeLaunchCommand(command, commandArgs);
    const child = spawn(launch.command, launch.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    });

    child.on("error", (error) => {
      error.step = `${command} ${commandArgs.join(" ")}`;
      reject(error);
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(`${command} ${commandArgs.join(" ")} exited with ${signal || code}`);
      error.step = commandArgs.join(" ");
      reject(error);
    });
  });
}

function makeLaunchCommand(command, commandArgs) {
  if (process.platform !== "win32" || command !== "npm") {
    return { command, args: commandArgs };
  }
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", windowsCommandLine(command, commandArgs)]
  };
}

function windowsCommandLine(command, args) {
  return [command, ...args].map(quoteWindowsArg).join(" ");
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_:/.-]+$/.test(text)) return text;
  return `"${text.replace(/(["^&|<>])/g, "^$1")}"`;
}
