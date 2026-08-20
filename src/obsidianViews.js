import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, atomicWriteJson } from "./fsSafe.js";

const VIEW_VERSION = "0.1";
const ACTION_NOTES_DIR = "ontology-action-notes";

export async function writeObsidianViews({ vault, config, graph, actionQueue } = {}) {
  const synthesesDir = path.join(vault, config.synthesesDir);
  await mkdir(synthesesDir, { recursive: true });
  const canvasPath = path.join(synthesesDir, "ontology.canvas");
  const basePath = path.join(synthesesDir, "ontology-actions.base");
  const actionNotesDir = path.join(synthesesDir, ACTION_NOTES_DIR);

  const actionNotePaths = await writeActionNotes({ actionNotesDir, actionQueue, graph });
  const canvas = renderOntologyCanvas(graph);
  const base = renderActionBase();
  await atomicWriteJson(canvasPath, canvas);
  await atomicWriteFile(basePath, base, { encoding: "utf8" });

  return {
    canvasPath,
    basePath,
    actionNotesDir,
    actionNotes: actionNotePaths.length
  };
}

export function renderOntologyCanvas(graph, { limit = 80 } = {}) {
  const objects = (graph?.objects || []).slice(0, limit);
  const objectIds = new Set(objects.map((object) => object.id));
  const lanes = {
    Concept: { x: 0, color: "4" },
    Entity: { x: 460, color: "5" },
    Source: { x: -460, color: "2" },
    Tag: { x: 920, color: "3" }
  };
  const rowByType = new Map();
  const nodes = objects.map((object) => {
    const lane = lanes[object.type] || { x: 0, color: "6" };
    const row = rowByType.get(object.type) || 0;
    rowByType.set(object.type, row + 1);
    const base = {
      id: nodeId(object.id),
      type: object.type === "Concept" && object.properties?.path ? "file" : "text",
      x: lane.x,
      y: row * 170,
      width: 360,
      height: 130,
      color: lane.color
    };
    if (base.type === "file") {
      return {
        ...base,
        file: object.properties.path
      };
    }
    return {
      ...base,
      text: renderObjectText(object)
    };
  });

  const edges = (graph?.links || [])
    .filter((link) => objectIds.has(link.from) && objectIds.has(link.to))
    .slice(0, limit * 3)
    .map((link, index) => ({
      id: edgeId(link, index),
      fromNode: nodeId(link.from),
      fromSide: "right",
      toNode: nodeId(link.to),
      toSide: "left",
      label: link.type,
      color: edgeColor(link.type)
    }));

  return { nodes, edges };
}

export function renderActionBase() {
  return [
    "filters:",
    "  and:",
    `    - 'file.inFolder("${slashPath(path.join("syntheses", ACTION_NOTES_DIR))}")'`,
    "properties:",
    "  status:",
    "    displayName: Status",
    "  action_type:",
    "    displayName: Action type",
    "  priority:",
    "    displayName: Priority",
    "  confidence:",
    "    displayName: Confidence",
    "  target_count:",
    "    displayName: Targets",
    "  source_action:",
    "    displayName: Action ID",
    "views:",
    "  - type: table",
    "    name: Ontology Actions",
    "    limit: 100",
    "    order:",
    "      - file.name",
    "      - status",
    "      - priority",
    "      - action_type",
    "      - confidence",
    "      - target_count",
    "      - source_action",
    "    sort:",
    "      - property: priority",
    "        direction: ASC",
    "      - property: status",
    "        direction: ASC",
    ""
  ].join("\n");
}

async function writeActionNotes({ actionNotesDir, actionQueue, graph }) {
  await rm(actionNotesDir, { recursive: true, force: true });
  await mkdir(actionNotesDir, { recursive: true });
  const objectById = new Map((graph?.objects || []).map((object) => [object.id, object]));
  const paths = [];
  for (const action of actionQueue?.actions || []) {
    const filePath = path.join(actionNotesDir, `${safeFileName(action.id)}.md`);
    await atomicWriteFile(filePath, renderActionNote(action, objectById), { encoding: "utf8" });
    paths.push(filePath);
  }
  return paths;
}

function renderActionNote(action, objectById) {
  const targets = (action.targets || []).map((target) => objectById.get(target)).filter(Boolean);
  const lines = [
    "---",
    "type: OntologyAction",
    `title: ${quoteYaml(`${action.type} ${action.priority}`)}`,
    `description: ${quoteYaml(action.description || "")}`,
    `source_action: ${quoteYaml(action.id)}`,
    `action_type: ${quoteYaml(action.type)}`,
    `status: ${quoteYaml(action.status)}`,
    `priority: ${quoteYaml(action.priority)}`,
    `confidence: ${Number(action.confidence || 0)}`,
    `target_count: ${Array.isArray(action.targets) ? action.targets.length : 0}`,
    `stale: ${Boolean(action.stale)}`,
    `created: ${quoteYaml(action.createdAt || "")}`,
    `updated: ${quoteYaml(action.updatedAt || "")}`,
    `okf_view_version: ${quoteYaml(VIEW_VERSION)}`,
    "tags:",
    "  - okf",
    "  - ontology-action",
    "---",
    "",
    `# ${action.type}`,
    "",
    action.description || "No description.",
    "",
    "## Targets / 目标",
    "",
    ...((targets.length ? targets : action.targets || []).map((target) => `- ${formatTarget(target)}`)),
    "",
    "## Lifecycle / 生命周期",
    "",
    `- Status / 状态: ${action.status}`,
    `- Priority / 优先级: ${action.priority}`,
    `- Confidence / 置信度: ${action.confidence}`,
    `- Action ID / 动作 ID: \`${action.id}\``
  ];
  return `${lines.join("\n")}\n`;
}

function renderObjectText(object) {
  const title = object.properties?.title || object.properties?.name || object.properties?.resource || object.id;
  const lines = [`# ${title}`, "", `Type: ${object.type}`];
  if (object.properties?.description) lines.push("", object.properties.description);
  if (object.properties?.kind) lines.push("", `Kind: ${object.properties.kind}`);
  if (object.properties?.source_type) lines.push("", `Source: ${object.properties.source_type}`);
  return lines.join("\n");
}

function formatTarget(target) {
  if (typeof target === "string") return `\`${target}\``;
  if (target.type === "Concept" && target.properties?.path) {
    return `[[${target.properties.path.replace(/\.md$/, "")}|${target.properties.title || target.id}]]`;
  }
  return `${target.type}: ${target.properties?.title || target.properties?.name || target.properties?.resource || target.id}`;
}

function nodeId(id) {
  return `n-${hash(id)}`;
}

function edgeId(link, index) {
  return `e-${hash(`${link.type}:${link.from}:${link.to}:${index}`)}`;
}

function hash(value) {
  let output = 0;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    output = ((output << 5) - output + text.charCodeAt(i)) | 0;
  }
  return Math.abs(output).toString(16).padStart(8, "0").slice(0, 16);
}

function edgeColor(type) {
  const colors = {
    derived_from: "2",
    has_tag: "3",
    mentions: "5",
    similar_to: "4",
    same_domain: "6"
  };
  return colors[type] || "1";
}

function safeFileName(value) {
  return String(value || "action")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "action";
}

function quoteYaml(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function slashPath(value) {
  return String(value || "").replaceAll("\\", "/");
}
