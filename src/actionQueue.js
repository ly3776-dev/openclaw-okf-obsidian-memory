import crypto from "node:crypto";

export const ACTION_QUEUE_VERSION = "0.1";
export const ACTION_STATUSES = ["proposed", "accepted", "in_progress", "done", "dismissed", "archived"];
export const ACTIVE_ACTION_STATUSES = ["proposed", "accepted", "in_progress"];
export const CLOSED_ACTION_STATUSES = ["done", "dismissed", "archived"];

export function buildActionQueue({ graph, previousQueue = null, generatedAt = new Date().toISOString() } = {}) {
  const previousById = new Map((previousQueue?.actions || []).map((action) => [action.id, action]));
  const current = (graph?.actions || []).map((action) => lifecycleAction(action, previousById.get(actionId(action)), generatedAt));
  const currentIds = new Set(current.map((action) => action.id));
  const archived = [];

  for (const previous of previousQueue?.actions || []) {
    if (currentIds.has(previous.id)) continue;
    if (previous.status === "accepted" || previous.status === "in_progress") {
      archived.push({
        ...previous,
        stale: true,
        updatedAt: previous.updatedAt || generatedAt
      });
    } else if (previous.status === "proposed") {
      archived.push({
        ...previous,
        status: "archived",
        stale: true,
        archivedReason: "suggestion_not_current",
        updatedAt: generatedAt
      });
    } else {
      archived.push(previous);
    }
  }

  const actions = [...current, ...archived].sort(compareActions);
  return {
    action_queue_version: ACTION_QUEUE_VERSION,
    generatedAt,
    lifecycle: {
      statuses: ACTION_STATUSES,
      activeStatuses: ACTIVE_ACTION_STATUSES,
      defaultStatus: "proposed"
    },
    actions
  };
}

export function validateActionQueue(queue, graph = null) {
  const issues = [];
  if (!queue || typeof queue !== "object") {
    return validationResult({ queue, issues: [issue("invalid_queue", "$", "Action queue must be an object.")] });
  }
  if (queue.action_queue_version !== ACTION_QUEUE_VERSION) {
    issues.push(issue("version_mismatch", "action_queue_version", `Expected action_queue_version ${ACTION_QUEUE_VERSION}.`));
  }
  if (!Array.isArray(queue.actions)) {
    issues.push(issue("actions_not_array", "actions", "Action queue actions must be an array."));
    return validationResult({ queue, issues });
  }

  const graphActionById = new Map((graph?.actions || []).map((action) => [actionId(action), action]));
  const objectIds = new Set((graph?.objects || []).map((object) => object.id));
  const ids = new Set();
  queue.actions.forEach((action, index) => validateQueueAction(action, index, ids, graphActionById, objectIds, issues));
  return validationResult({ queue, issues });
}

export function summarizeActionQueue(queue) {
  const counts = Object.fromEntries(ACTION_STATUSES.map((status) => [status, 0]));
  for (const action of queue?.actions || []) {
    if (counts[action.status] !== undefined) counts[action.status] += 1;
  }
  return {
    total: (queue?.actions || []).length,
    active: ACTIVE_ACTION_STATUSES.reduce((sum, status) => sum + (counts[status] || 0), 0),
    counts
  };
}

export function updateActionStatus(queue, { id, status, note = "", updatedAt = new Date().toISOString() } = {}) {
  if (!queue || typeof queue !== "object" || !Array.isArray(queue.actions)) {
    throw new Error("Action queue must be loaded before updating an action.");
  }
  if (!nonEmptyString(id)) throw new Error("Action id is required.");
  if (!ACTION_STATUSES.includes(status)) throw new Error(`Invalid action status: ${status || ""}`);

  let updatedAction = null;
  const actions = queue.actions.map((action) => {
    if (action.id !== id) return action;
    const history = Array.isArray(action.history) ? action.history : [];
    updatedAction = {
      ...action,
      status,
      updatedAt,
      history: [
        ...history,
        {
          at: updatedAt,
          from: action.status,
          to: status,
          note: String(note || "").trim()
        }
      ]
    };
    if (CLOSED_ACTION_STATUSES.includes(status)) {
      updatedAction.closedAt = updatedAt;
    } else {
      delete updatedAction.closedAt;
    }
    if (status === "archived" && !updatedAction.archivedReason) {
      updatedAction.archivedReason = String(note || "").trim() || "manual_update";
    }
    return updatedAction;
  });

  if (!updatedAction) throw new Error(`Action not found: ${id}`);
  return {
    queue: {
      ...queue,
      generatedAt: queue.generatedAt || updatedAt,
      updatedAt,
      actions: actions.sort(compareActions)
    },
    action: updatedAction
  };
}

export function renderActionQueueMarkdown(queue, graph = null) {
  const objectById = new Map((graph?.objects || []).map((object) => [object.id, object]));
  const rows = (queue?.actions || [])
    .filter((action) => ACTIVE_ACTION_STATUSES.includes(action.status))
    .slice(0, 24)
    .map((action) => [
      `- [${action.status}] ${action.priority} ${action.type}: ${action.description}`,
      `  - ID / ID: \`${action.id}\``,
      `  - Targets / 目标: ${formatTargets(action.targets, objectById)}`
    ].join("\n"))
    .join("\n");
  const summary = summarizeActionQueue(queue);
  return `# Ontology Action Queue / Ontology 动作队列

- Total / 总数: ${summary.total}
- Active / 活跃: ${summary.active}
- Proposed / 待确认: ${summary.counts.proposed}
- Accepted / 已接受: ${summary.counts.accepted}
- In progress / 进行中: ${summary.counts.in_progress}
- Done / 已完成: ${summary.counts.done}
- Dismissed / 已忽略: ${summary.counts.dismissed}
- Archived / 已归档: ${summary.counts.archived}

## Active Actions / 当前动作

${rows || "- No active ontology actions. / 暂无活跃 ontology 动作。"}

## Lifecycle Commands / 生命周期命令

- List / 列出: \`node ./src/cli.js action-list --vault <vault>\`
- Update / 更新: \`node ./src/cli.js action-update --vault <vault> --id <action-id> --status accepted\`
- Execute / 执行: \`node ./src/cli.js action-execute --vault <vault> --id <action-id>\`
`;
}

function lifecycleAction(action, previous, generatedAt) {
  const id = actionId(action);
  const priority = priorityFor(action);
  const stable = {
    id,
    type: action.type,
    targets: Array.isArray(action.targets) ? action.targets : [],
    description: action.description || "",
    confidence: action.confidence ?? 0,
    priority,
    status: normalizeStatus(previous?.status || "proposed"),
    source: "ontology",
    stale: false,
    createdAt: previous?.createdAt || generatedAt,
    updatedAt: previous?.updatedAt || generatedAt
  };
  if (previous?.history) stable.history = previous.history;
  if (previous?.closedAt) stable.closedAt = previous.closedAt;
  if (previous?.archivedReason) stable.archivedReason = previous.archivedReason;
  if (previous && hasActionChanged(previous, stable)) stable.updatedAt = generatedAt;
  return stable;
}

function actionId(action) {
  const text = JSON.stringify({
    type: action?.type || "",
    targets: Array.isArray(action?.targets) ? action.targets : []
  });
  const hash = crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
  return `action:${action?.type || "unknown"}:${hash}`;
}

function priorityFor(action) {
  const confidence = Number(action?.confidence || 0);
  if (confidence >= 0.85) return "high";
  if (confidence >= 0.68) return "medium";
  return "low";
}

function normalizeStatus(status) {
  return ACTION_STATUSES.includes(status) ? status : "proposed";
}

function hasActionChanged(previous, next) {
  return previous.type !== next.type ||
    previous.description !== next.description ||
    previous.confidence !== next.confidence ||
    previous.priority !== next.priority ||
    JSON.stringify(previous.targets || []) !== JSON.stringify(next.targets || []);
}

function validateQueueAction(action, index, ids, graphActionById, objectIds, issues) {
  const pathValue = `actions[${index}]`;
  if (!action || typeof action !== "object") {
    issues.push(issue("invalid_action", pathValue, "Queue action must be an object."));
    return;
  }
  if (!nonEmptyString(action.id)) {
    issues.push(issue("missing_action_id", `${pathValue}.id`, "Queue action requires a stable id."));
  } else if (ids.has(action.id)) {
    issues.push(issue("duplicate_action_id", `${pathValue}.id`, `Duplicate action id ${action.id}.`));
  } else {
    ids.add(action.id);
  }
  if (!nonEmptyString(action.type)) issues.push(issue("missing_action_type", `${pathValue}.type`, "Queue action requires type."));
  if (!ACTION_STATUSES.includes(action.status)) {
    issues.push(issue("invalid_action_status", `${pathValue}.status`, `Invalid action status ${action.status || ""}.`));
  }
  if (!["high", "medium", "low"].includes(action.priority)) {
    issues.push(issue("invalid_action_priority", `${pathValue}.priority`, "Action priority must be high, medium, or low."));
  }
  if (!Array.isArray(action.targets)) {
    issues.push(issue("invalid_action_targets", `${pathValue}.targets`, "Action targets must be an array."));
  } else if (objectIds.size && !action.stale) {
    action.targets.forEach((target, targetIndex) => {
      if (!objectIds.has(target)) {
        issues.push(issue("missing_action_target", `${pathValue}.targets[${targetIndex}]`, `Action target does not exist in ontology graph: ${target || ""}.`));
      }
    });
  }
  if (typeof action.confidence !== "number" || action.confidence < 0 || action.confidence > 1) {
    issues.push(issue("invalid_action_confidence", `${pathValue}.confidence`, "Action confidence must be between 0 and 1."));
  }
  if (!nonEmptyString(action.description)) {
    issues.push(issue("missing_action_description", `${pathValue}.description`, "Queue action requires a description."));
  }
  if (!nonEmptyString(action.createdAt)) issues.push(issue("missing_created_at", `${pathValue}.createdAt`, "Queue action requires createdAt."));
  if (!nonEmptyString(action.updatedAt)) issues.push(issue("missing_updated_at", `${pathValue}.updatedAt`, "Queue action requires updatedAt."));
  if (!action.stale && graphActionById.size && !graphActionById.has(action.id)) {
    issues.push(issue("missing_graph_action", `${pathValue}.id`, "Non-stale queue action must correspond to a current ontology action."));
  }
}

function validationResult({ queue, issues }) {
  return {
    ok: issues.length === 0,
    actionQueueVersion: queue?.action_queue_version || "",
    actions: Array.isArray(queue?.actions) ? queue.actions.length : 0,
    summary: summarizeActionQueue(queue),
    issues
  };
}

function issue(code, pathValue, message) {
  return { code, path: pathValue, message };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function compareActions(a, b) {
  const statusRank = statusOrder(a.status) - statusOrder(b.status);
  if (statusRank) return statusRank;
  const priorityRank = priorityOrder(a.priority) - priorityOrder(b.priority);
  if (priorityRank) return priorityRank;
  return String(a.type).localeCompare(String(b.type));
}

function statusOrder(status) {
  const order = { proposed: 0, accepted: 1, in_progress: 2, done: 3, dismissed: 4, archived: 5 };
  return order[status] ?? 9;
}

function priorityOrder(priority) {
  const order = { high: 0, medium: 1, low: 2 };
  return order[priority] ?? 9;
}

function formatTargets(targets, objectById) {
  return (targets || [])
    .map((target) => {
      const object = objectById.get(target);
      return object?.properties?.title || object?.properties?.name || object?.properties?.resource || target;
    })
    .join(", ");
}
