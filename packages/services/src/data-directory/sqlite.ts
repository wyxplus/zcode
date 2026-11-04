import { createRequire } from "node:module";
import type { DatabaseSync as Database } from "node:sqlite";
import { migrationError, type MigrationPathMapping } from "./types.js";
import { rewriteManagedPath, rewriteStructuredPaths } from "./transforms.js";
import { validateManagedReferences } from "./validation.js";
import { mapStoredSessionReferences } from "./session-json.js";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

function tableCounts(db: Database): Record<string, number> {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      (db.prepare(`SELECT count(*) AS n FROM ${quote(name)}`).get() as { n: number }).n,
    ]),
  );
}

export function verifyDatabase(db: Database): void {
  const result = db.prepare("PRAGMA integrity_check").all();
  if (result.length !== 1 || Object.values(result[0] ?? {})[0] !== "ok")
    migrationError("INTEGRITY", "数据库完整性校验失败");
  if (db.prepare("PRAGMA foreign_key_check").all().length > 0)
    migrationError("INTEGRITY", "数据库外键校验失败");
}

export async function copyDatabase(sourcePath: string, destination: string): Promise<void> {
  const source = new sqlite.DatabaseSync(sourcePath, { readOnly: true });
  try {
    verifyDatabase(source);
    const counts = tableCounts(source);
    await sqlite.backup(source, destination);
    const copy = new sqlite.DatabaseSync(destination, { readOnly: true });
    try {
      verifyDatabase(copy);
      if (JSON.stringify(counts) !== JSON.stringify(tableCounts(copy)))
        migrationError("INTEGRITY", "数据库复制前后的记录数不一致");
    } finally {
      copy.close();
    }
  } finally {
    source.close();
  }
}

export async function validateDatabaseReferences(
  path: string,
  stagingRoot: string,
  finalRoot: string,
): Promise<void> {
  const db = new sqlite.DatabaseSync(path, { readOnly: true });
  try {
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    for (const [table, field] of [
      ["part", "data"],
      ["session_entry", "data"],
      ["input_history", "attachments"],
      ["session_input", "payload"],
    ] as const) {
      if (!tables.has(table) || !columns(db, table).has(field)) continue;
      for (const row of db
        .prepare(
          "SELECT " +
            quote(field) +
            " AS value" +
            (columns(db, table).has("type") ? ",type" : "") +
            " FROM " +
            quote(table) +
            " WHERE " +
            quote(field) +
            " IS NOT NULL",
        )
        .iterate()) {
        const references: unknown[] = [];
        mapStoredSessionReferences(
          table,
          JSON.parse(String(row.value)),
          (value) => {
            references.push(value);
            return value;
          },
          typeof row.type === "string" ? row.type : undefined,
        );
        for (const reference of references)
          await validateManagedReferences(reference, stagingRoot, finalRoot);
      }
    }
  } finally {
    db.close();
  }
}

function columns(db: Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
}

/** 冻结历史 project_id 算法，仅用于搬迁旧数据；不重新分配 session ID 或远端 identity。 */
function legacyProjectId(directory: string): string {
  return (
    directory
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "default"
  );
}

export function rewriteDatabasePaths(
  path: string,
  mappings: MigrationPathMapping[],
): Map<string, string> {
  const db = new sqlite.DatabaseSync(path);
  const workspaceMoves = new Map<string, string>();
  const tables = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );
  const projectMoves = new Map<string, string>();
  db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
  try {
    if (tables.has("session")) {
      const fields = columns(db, "session");
      if (fields.has("id") && fields.has("directory")) {
        const rows = db.prepare("SELECT * FROM session").all() as Array<
          Record<string, string | null>
        >;
        const pendingUpdates = new Map<string, Record<string, string>>();
        for (const row of rows) {
          if (!row.id || !row.directory || row.workspace_id) continue;
          const directory = rewriteManagedPath(row.directory, mappings);
          if (directory === row.directory) continue;
          workspaceMoves.set(row.directory, directory);
          const updates: Record<string, string> = { directory };
          if (fields.has("path") && row.path) updates.path = rewriteManagedPath(row.path, mappings);
          if (fields.has("project_id") && row.project_id === legacyProjectId(row.directory)) {
            updates.project_id = legacyProjectId(directory);
            const previousTarget = projectMoves.get(row.project_id);
            if (previousTarget && previousTarget !== updates.project_id)
              migrationError("SOURCE_CONFLICT", "一个历史 project ID 对应多个迁移目标");
            projectMoves.set(row.project_id, updates.project_id);
          }
          pendingUpdates.set(row.id, updates);
        }
        // 历史 ID 只保留 80 字符；新根更长时不同工作区可能碰撞，不能静默合并权限和输入历史。
        for (const [sourceProject, targetProject] of projectMoves) {
          for (const row of rows) {
            const projectedId =
              (row.id && pendingUpdates.get(row.id)?.project_id) || row.project_id;
            if (
              (projectedId === targetProject && row.project_id !== sourceProject) ||
              (row.project_id === sourceProject && projectedId !== targetProject)
            ) {
              migrationError("SOURCE_CONFLICT", "迁移后的 project ID 与另一个工作区冲突");
            }
          }
        }
        for (const [id, updates] of pendingUpdates) {
          db.prepare(
            `UPDATE session SET ${Object.keys(updates)
              .map((key) => `${quote(key)}=?`)
              .join(",")} WHERE id=?`,
          ).run(...Object.values(updates), id);
        }
      }
    }
    for (const table of ["tasks", "task_group_members", "automations", "off_peak_tasks"]) {
      if (!tables.has(table)) continue;
      const fields = columns(db, table);
      if (!fields.has("workspace_path")) continue;
      const rows = db
        .prepare(
          `SELECT DISTINCT workspace_path${fields.has("workspace_identity") ? ",workspace_identity" : ""} FROM ${quote(table)}`,
        )
        .all() as Array<{ workspace_path: string; workspace_identity?: string | null }>;
      for (const row of rows) {
        if (row.workspace_identity) continue;
        const target = rewriteManagedPath(row.workspace_path, mappings);
        if (target === row.workspace_path) continue;
        workspaceMoves.set(row.workspace_path, target);
        db.prepare(
          `UPDATE ${quote(table)} SET workspace_path=?${fields.has("workspace_key") ? ",workspace_key=CASE WHEN workspace_key=? THEN ? ELSE workspace_key END" : ""} WHERE workspace_path=?${fields.has("workspace_identity") ? " AND (workspace_identity IS NULL OR workspace_identity='')" : ""}`,
        ).run(
          ...(fields.has("workspace_key")
            ? [target, row.workspace_path, target, row.workspace_path]
            : [target, row.workspace_path]),
        );
      }
    }
    for (const table of ["task_group_workspace_bootstraps", "automation_runs"]) {
      if (!tables.has(table) || !columns(db, table).has("workspace_key")) continue;
      const rows = db.prepare(`SELECT DISTINCT workspace_key FROM ${quote(table)}`).all() as Array<{
        workspace_key: string;
      }>;
      for (const row of rows) {
        const target = rewriteManagedPath(row.workspace_key, mappings);
        if (target !== row.workspace_key)
          db.prepare(`UPDATE ${quote(table)} SET workspace_key=? WHERE workspace_key=?`).run(
            target,
            row.workspace_key,
          );
      }
    }
    if (tables.has("task_group_view_node_orders")) {
      const rows = db
        .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type='task'")
        .all() as Array<{ node_key: string }>;
      for (const row of rows) {
        const tuple: unknown = JSON.parse(row.node_key);
        if (
          !Array.isArray(tuple) ||
          tuple.length !== 2 ||
          !tuple.every((entry) => typeof entry === "string")
        )
          migrationError("INTEGRITY", "任务排序键格式不正确");
        const targetKey = rewriteManagedPath(tuple[0] as string, mappings);
        if (targetKey !== tuple[0]) {
          db.prepare(
            "UPDATE task_group_view_node_orders SET node_key=? WHERE node_type='task' AND node_key=?",
          ).run(JSON.stringify([targetKey, tuple[1]]), row.node_key);
        }
      }
    }
    for (const table of ["permission", "input_history"]) {
      if (!tables.has(table) || !columns(db, table).has("project_id")) continue;
      for (const [source, target] of projectMoves)
        db.prepare(`UPDATE ${quote(table)} SET project_id=? WHERE project_id=?`).run(
          target,
          source,
        );
    }
    for (const [table, field] of [
      ["message", "data"],
      ["part", "data"],
      ["session_entry", "data"],
      ["input_history", "attachments"],
      ["session_input", "payload"],
    ] as const) {
      if (!tables.has(table)) continue;
      const fields = columns(db, table);
      if (!fields.has("id") || !fields.has(field)) continue;
      const rows = db
        .prepare(
          "SELECT id, " +
            quote(field) +
            " AS value" +
            (fields.has("type") ? ",type" : "") +
            " FROM " +
            quote(table) +
            " WHERE " +
            quote(field) +
            " IS NOT NULL",
        )
        .all() as Array<{ id: string; value: string; type?: string }>;
      for (const row of rows) {
        const original = JSON.parse(row.value);
        const updated = mapStoredSessionReferences(
          table,
          original,
          (value) => rewriteStructuredPaths(value, mappings),
          row.type,
        );
        if (JSON.stringify(original) !== JSON.stringify(updated)) {
          db.prepare("UPDATE " + quote(table) + " SET " + quote(field) + "=? WHERE id=?").run(
            JSON.stringify(updated),
            row.id,
          );
        }
      }
    }
    verifyDatabase(db);
    db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
    return workspaceMoves;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 原失败优先；目标副本不会被提交。 */
    }
    throw error;
  } finally {
    db.close();
  }
}
