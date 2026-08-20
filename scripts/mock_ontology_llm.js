#!/usr/bin/env node

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const payload = JSON.parse(input || "{}");
  const objects = payload.graph?.objects?.length || 0;
  const links = payload.graph?.links?.length || 0;
  process.stdout.write([
    "## Important Links",
    "",
    `- Reviewed ${objects} ontology objects and ${links} links.`,
    "",
    "## Missing Context",
    "",
    "- Mock LLM review found no uncited external claims.",
    "",
    "## Suggested Actions",
    "",
    "- Promote repeated entities into dedicated object notes."
  ].join("\n"));
});
