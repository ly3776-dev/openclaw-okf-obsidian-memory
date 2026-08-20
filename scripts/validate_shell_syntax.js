#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const webTreeRoot = path.join(root, "node_modules", "openclaw", "node_modules", "web-tree-sitter");
const bashRoot = path.join(root, "node_modules", "openclaw", "node_modules", "tree-sitter-bash");
const { Parser, Language } = await import(pathToFileURL(path.join(webTreeRoot, "web-tree-sitter.js")).href);
await Parser.init({ locateFile: () => path.join(webTreeRoot, "web-tree-sitter.wasm") });
const language = await Language.load(path.join(bashRoot, "tree-sitter-bash.wasm"));
const parser = new Parser();
parser.setLanguage(language);

const files = process.argv.slice(2).length ? process.argv.slice(2) : [
  "install-linux.sh",
  "scripts/bootstrap_linux.sh",
  "scripts/start_bge_m3.sh",
  "scripts/install_bge_service_linux.sh"
];
const results = [];
for (const rel of files) {
  const source = await readFile(path.resolve(rel), "utf8");
  const tree = parser.parse(source);
  const errors = collectErrors(tree.rootNode);
  results.push({ file: rel, ok: errors.length === 0, errors });
}
const result = { ok: results.every((item) => item.ok), parser: "tree-sitter-bash", results };
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

function collectErrors(node, output = []) {
  if (node.type === "ERROR" || node.isMissing) output.push({ type: node.type, start: node.startPosition, end: node.endPosition, text: node.text.slice(0, 200) });
  for (const child of node.children) collectErrors(child, output);
  return output;
}
