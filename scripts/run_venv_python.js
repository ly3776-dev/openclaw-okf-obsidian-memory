#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const python = process.platform === "win32"
  ? path.join(root, ".venv", "Scripts", "python.exe")
  : path.join(root, ".venv", "bin", "python");
if (!existsSync(python)) {
  console.error(`Project .venv is missing / 缺少项目 .venv: ${python}`);
  process.exit(1);
}
if (process.argv.length < 3) {
  console.error("Usage / 用法: node scripts/run_venv_python.js <script> [args...]");
  process.exit(2);
}
const child = spawn(python, process.argv.slice(2), { cwd: root, stdio: "inherit", windowsHide: true, shell: false });
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = Number.isInteger(code) ? code : (signal ? 1 : 0); });
