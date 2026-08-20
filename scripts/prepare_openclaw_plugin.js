#!/usr/bin/env node
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const target = path.join(root, ".okf-install", `openclaw-plugin-${pkg.version}`);
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const rel of ["plugin", "src", "skill", "scripts"]) {
  await cp(path.join(root, rel), path.join(target, rel), { recursive: true, filter: shouldCopy });
}
for (const rel of ["package.json", "openclaw.plugin.json"]) {
  await cp(path.join(root, rel), path.join(target, rel));
}
const marker = { generatedAt: new Date().toISOString(), sourceRoot: root, version: pkg.version };
await writeFile(path.join(target, "INSTALL_SOURCE.json"), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
await normalizePermissions(target);
if (process.argv.includes("--print-path")) console.log(target);
else console.log(JSON.stringify({ ok: true, target, included: ["plugin", "src", "skill", "scripts", "package.json", "openclaw.plugin.json"] }, null, 2));

async function normalizePermissions(directory) {
  await chmod(directory, 0o755);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await normalizePermissions(entryPath);
    else if (entry.isFile()) await chmod(entryPath, 0o644);
  }
}

function shouldCopy(source) {
  const parts = path.normalize(source).split(path.sep);
  return !parts.includes("__pycache__") && path.extname(source).toLowerCase() !== ".pyc";
}
