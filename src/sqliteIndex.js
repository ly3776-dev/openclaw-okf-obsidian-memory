import path from "node:path";
import { mkdir } from "node:fs/promises";

export const SQLITE_INDEX_VERSION = "0.1";

export async function buildSqliteIndex({ vault, config, notes, graph = null, actionQueue = null, sourceGeneration = "" } = {}) {
  const sqlite = await loadNodeSqlite();
  const dbPath = sqliteIndexPath(vault, config);
  if (!sqlite.ok) {
    return { ok: false, skipped: true, unavailable: true, reason: sqlite.reason, dbPath };
  }

  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    createSchema(db);
    db.exec("BEGIN;");
    clearIndex(db);
    insertMeta(db, sourceGeneration);
    insertNotes(db, notes || []);
    insertOntology(db, graph);
    insertActions(db, actionQueue);
    db.exec("COMMIT;");
    return {
      ok: true,
      skipped: false,
      unavailable: false,
      dbPath,
      notes: (notes || []).length,
      objects: graph?.objects?.length || 0,
      links: graph?.links?.length || 0,
      actions: actionQueue?.actions?.length || 0
    };
  } catch (error) {
    try { db.exec("ROLLBACK;"); } catch {}
    return { ok: false, skipped: false, unavailable: false, reason: error.message, dbPath };
  } finally {
    db.close();
  }
}

export async function updateSqliteIndex({ vault, config, changedNotes = [], deletedPaths = [], previousGeneration = "", sourceGeneration = "", allNotes = [] } = {}) {
  const sqlite = await loadNodeSqlite();
  const dbPath = sqliteIndexPath(vault, config);
  if (!sqlite.ok) return { ok: false, skipped: true, unavailable: true, reason: sqlite.reason, dbPath };
  await mkdir(path.dirname(dbPath), { recursive: true });
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    createSchema(db);
    if (readMeta(db, "source_generation") !== previousGeneration) {
      db.close();
      db = null;
      return buildSqliteIndex({ vault, config, notes: allNotes, sourceGeneration });
    }
    db.exec("BEGIN;");
    for (const notePath of deletedPaths) deleteNote(db, notePath);
    for (const note of changedNotes) upsertNote(db, note);
    setMeta(db, "generated_at", new Date().toISOString());
    setMeta(db, "source_generation", sourceGeneration || "");
    db.exec("COMMIT;");
    return { ok: true, skipped: false, unavailable: false, incremental: true, dbPath, notes: allNotes.length };
  } catch (error) {
    try { db?.exec("ROLLBACK;"); } catch {}
    return { ok: false, skipped: false, unavailable: false, reason: error.message, dbPath };
  } finally {
    try { db?.close(); } catch {}
  }
}

export async function rankSqliteRecall({ vault, config, query = "", limit = 5, sourceGeneration = "" } = {}) {
  const sqlite = await loadNodeSqlite();
  const dbPath = sqliteIndexPath(vault, config);
  if (!sqlite.ok) return [];

  let db = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    if (sourceGeneration && readMeta(db, "source_generation") !== sourceGeneration) return [];
    const fts = runFtsQuery(db, query, limit);
    const like = fts.length ? [] : runLikeQuery(db, query, limit);
    const byPath = new Map();
    for (const item of [...fts, ...like]) {
      const existing = byPath.get(item.path);
      if (!existing || item.score > existing.score) byPath.set(item.path, item);
    }
    return [...byPath.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  } catch {
    return [];
  } finally {
    if (db) db.close();
  }
}

export function sqliteIndexPath(vault, config) {
  return path.join(vault || ".", config?.cacheDir || ".okf-cache", "okf-memory.sqlite");
}

async function loadNodeSqlite() {
  try {
    const mod = await import("node:sqlite");
    if (!mod.DatabaseSync) return { ok: false, reason: "node:sqlite DatabaseSync is unavailable" };
    return { ok: true, DatabaseSync: mod.DatabaseSync };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      path TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      body TEXT,
      tags TEXT,
      type TEXT,
      timestamp TEXT,
      resource TEXT,
      confidence REAL,
      source_type TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      path UNINDEXED,
      title,
      description,
      body,
      tags,
      tokenize = 'unicode61'
    );
    CREATE TABLE IF NOT EXISTS ontology_objects (
      id TEXT PRIMARY KEY,
      type TEXT,
      title TEXT,
      properties_json TEXT
    );
    CREATE TABLE IF NOT EXISTS ontology_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      from_id TEXT,
      to_id TEXT,
      confidence REAL,
      evidence_json TEXT
    );
    CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT,
      priority TEXT,
      confidence REAL,
      description TEXT,
      targets_json TEXT,
      updated_at TEXT
    );
  `);
}

function clearIndex(db) {
  for (const table of ["meta", "notes", "notes_fts", "ontology_objects", "ontology_links", "actions"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

function insertMeta(db, sourceGeneration) {
  const stmt = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  stmt.run("sqlite_index_version", SQLITE_INDEX_VERSION);
  stmt.run("generated_at", new Date().toISOString());
  stmt.run("source_generation", sourceGeneration || "");
}

function setMeta(db, key, value) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value || ""));
}

function readMeta(db, key) {
  try {
    return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value || "";
  } catch {
    return "";
  }
}

function insertNotes(db, notes) {
  for (const note of notes) upsertNote(db, note);
}

function upsertNote(db, note) {
  const tags = Array.isArray(note.tags) ? note.tags.join(" ") : String(note.tags || "");
  db.prepare(`
    INSERT INTO notes (path, title, description, body, tags, type, timestamp, resource, confidence, source_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      title=excluded.title, description=excluded.description, body=excluded.body, tags=excluded.tags,
      type=excluded.type, timestamp=excluded.timestamp, resource=excluded.resource,
      confidence=excluded.confidence, source_type=excluded.source_type
  `).run(
    note.path, note.title || "", note.description || "", note.body || "", tags,
    note.type || "", note.timestamp || "", note.resource || "", Number(note.confidence || 0), note.source_type || ""
  );
  db.prepare("DELETE FROM notes_fts WHERE path = ?").run(note.path);
  db.prepare("INSERT INTO notes_fts (path, title, description, body, tags) VALUES (?, ?, ?, ?, ?)")
    .run(note.path, note.title || "", note.description || "", note.body || "", tags);
}

function deleteNote(db, notePath) {
  db.prepare("DELETE FROM notes WHERE path = ?").run(notePath);
  db.prepare("DELETE FROM notes_fts WHERE path = ?").run(notePath);
}

function insertOntology(db, graph) {
  if (!graph) return;
  const objectStmt = db.prepare("INSERT INTO ontology_objects (id, type, title, properties_json) VALUES (?, ?, ?, ?)");
  for (const object of graph.objects || []) {
    objectStmt.run(object.id, object.type || "", objectTitle(object), JSON.stringify(object.properties || {}));
  }
  const linkStmt = db.prepare("INSERT INTO ontology_links (type, from_id, to_id, confidence, evidence_json) VALUES (?, ?, ?, ?, ?)");
  for (const link of graph.links || []) {
    linkStmt.run(link.type || "", link.from || "", link.to || "", Number(link.confidence || 0), JSON.stringify(link.evidence || []));
  }
}

function insertActions(db, actionQueue) {
  const stmt = db.prepare(`
    INSERT INTO actions (id, type, status, priority, confidence, description, targets_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const action of actionQueue?.actions || []) {
    stmt.run(
      action.id,
      action.type || "",
      action.status || "",
      action.priority || "",
      Number(action.confidence || 0),
      action.description || "",
      JSON.stringify(action.targets || []),
      action.updatedAt || ""
    );
  }
}

function runFtsQuery(db, query, limit) {
  const expression = ftsExpression(query);
  if (!expression) return [];
  try {
    const stmt = db.prepare(`
      SELECT n.path, n.title, n.description, snippet(notes_fts, 3, '', '', '...', 18) AS preview,
             1.0 / (1.0 + bm25(notes_fts)) AS score
      FROM notes_fts
      JOIN notes n ON n.path = notes_fts.path
      WHERE notes_fts MATCH ?
      ORDER BY bm25(notes_fts)
      LIMIT ?
    `);
    return stmt.all(expression, limit).map((row) => ({
      path: row.path,
      title: row.title,
      description: row.description || row.preview || "",
      score: Number(Math.max(0.01, row.score || 0.01).toFixed(4)),
      preview: row.preview || row.description || "",
      signal: "sqlite_fts"
    }));
  } catch {
    return [];
  }
}

function runLikeQuery(db, query, limit) {
  const tokens = tokenize(query).slice(0, 8);
  if (!tokens.length) return [];
  const candidateLimit = Math.min(500, Math.max(50, limit * 10));
  const haystack = "lower(coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(tags, '') || ' ' || coalesce(body, ''))";
  const where = tokens.map(() => `${haystack} LIKE ? ESCAPE '\\'`).join(" OR ");
  const parameters = tokens.map((token) => `%${escapeLike(token.toLowerCase())}%`);
  const rows = db.prepare(`SELECT path, title, description, body, tags FROM notes WHERE ${where} LIMIT ?`)
    .all(...parameters, candidateLimit);
  return rows
    .map((row) => {
      const haystack = `${row.title || ""} ${row.description || ""} ${row.tags || ""} ${row.body || ""}`.toLowerCase();
      const score = tokens.reduce((sum, token) => sum + (haystack.includes(token.toLowerCase()) ? 1 : 0), 0);
      return {
        path: row.path,
        title: row.title,
        description: row.description || "",
        score: score / Math.max(1, tokens.length),
        preview: String(row.body || row.description || "").slice(0, 260),
        signal: "sqlite_like"
      };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => ({ ...row, score: Number(row.score.toFixed(4)) }));
}

function escapeLike(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function ftsExpression(query) {
  const tokens = tokenize(query).slice(0, 8);
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

function tokenize(text) {
  return String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function objectTitle(object) {
  return object?.properties?.title || object?.properties?.name || object?.properties?.resource || object?.id || "";
}
