#!/usr/bin/env node

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const payload = JSON.parse(input || "{}");
  process.stdout.write(JSON.stringify({
    text: `Mock research context for ${payload.title || "untitled"}: this capture relates to ontology-backed operational memory.`,
    citations: ["https://example.com/mock-ontology-source"]
  }));
});
