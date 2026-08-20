#!/usr/bin/env node
import { resolveInstallSources } from "../src/installSources.js";

const args = parseArgs(process.argv.slice(2));
const result = resolveInstallSources({
  profile: args.profile || "CN",
  npmRegistry: args.npmRegistry,
  pipIndexUrl: args.pipIndexUrl,
  hfEndpoint: args.hfEndpoint,
  modelHub: args.modelHub,
  paddleModelSource: args.paddleModelSource
});
console.log(JSON.stringify(result, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else { parsed[key] = next; index += 1; }
  }
  return parsed;
}
