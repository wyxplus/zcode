import { lstat, open, readdir, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { hashFile, safeRelativePath } from "./io.js";
import { migrationError, type DataDirectorySource, type MigrationFile } from "./types.js";

const SQLITE_HEADER = "SQLite format 3\u0000";
const slashPath = (path: string) => path.split(sep).join("/");

async function isSqlite(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return bytesRead === 16 && buffer.toString("utf8") === SQLITE_HEADER;
  } finally {
    await file.close();
  }
}

function excluded(path: string, source: DataDirectorySource): boolean {
  const normalized = slashPath(path);
  return (source.exclude ?? []).some((entry) => {
    const excludedPath = entry.replaceAll("\\", "/");
    return normalized === excludedPath || normalized.startsWith(`${excludedPath}/`);
  });
}

export async function inventoryMigrationSources(
  sources: DataDirectorySource[],
): Promise<MigrationFile[]> {
  const result = new Map<string, MigrationFile>();
  async function visit(source: DataDirectorySource, path: string) {
    const sourceRelative = relative(source.sourcePath, path);
    if (sourceRelative && excluded(sourceRelative, source)) return;
    const relativePath = safeRelativePath(join(source.targetRelativePath, sourceRelative));
    const stat = await lstat(path);
    const entry: MigrationFile = {
      source: path,
      relativePath,
      size: stat.size,
      mode: stat.mode,
      kind: "file",
    };
    if (stat.isDirectory()) {
      entry.kind = "directory";
    } else if (stat.isSymbolicLink()) {
      entry.kind = "symlink";
      entry.linkTarget = await readlink(path);
    } else if (stat.isFile()) {
      const targetName = slashPath(relativePath);
      const ownedDatabase = ["cli/db/db.sqlite", "v2/tasks-index.sqlite"].includes(targetName);
      // 未知用户/插件 SQLite 也可能包含坏页或故意禁用的外键；不能因文件头相似就打开、修复或 checkpoint。
      // 只有产品数据库与 Electron profile 用 backup，其余文件及 sidecar 都按原始字节复制校验。
      entry.kind =
        (ownedDatabase || targetName.startsWith("desktop/")) && (await isSqlite(path))
          ? "sqlite"
          : "file";
      entry.hash = await hashFile(path);
      if (entry.kind === "sqlite") {
        try {
          const walSize = (await lstat(path + "-wal")).size;
          // WAL 模式的只读连接也会创建空 WAL；它与不存在的 WAL 都没有事务帧，不能误判为用户数据变化。
          // 非空 WAL 仍完整计算哈希，未知用户数据库的 sidecar 则继续按普通文件逐字节校验。
          if (walSize > 0) {
            entry.walSize = walSize;
            entry.walHash = await hashFile(path + "-wal");
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      } else if (ownedDatabase) {
        migrationError("INTEGRITY", "当前会话数据库不是有效的 SQLite 文件：" + relativePath);
      }
    } else {
      migrationError("UNSUPPORTED_ENTRY", `来源包含不能安全迁移的文件类型：${path}`);
    }
    const key = process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
    const prior = result.get(key);
    if (
      prior &&
      prior.source !== entry.source &&
      !(prior.kind === "directory" && entry.kind === "directory")
    ) {
      migrationError("SOURCE_CONFLICT", `多个来源映射到同一文件：${relativePath}`);
    }
    if (!prior) result.set(key, entry);
    if (entry.kind === "directory") {
      for (const child of (await readdir(path)).sort()) await visit(source, join(path, child));
    }
  }
  for (const source of sources) {
    const sourcePath = source.canonicalSourcePath ?? source.sourcePath;
    await visit({ ...source, sourcePath }, sourcePath);
  }
  const sqlitePaths = new Set(
    [...result.values()].filter((entry) => entry.kind === "sqlite").map((entry) => entry.source),
  );
  // 仅排除由 SQLite backup 纳入一致快照的 sidecar；未知用户数据库的 WAL/SHM 必须保留原字节。
  return [...result.values()].filter(
    (entry) =>
      !["-wal", "-shm", "-journal"].some(
        (suffix) =>
          entry.source.endsWith(suffix) && sqlitePaths.has(entry.source.slice(0, -suffix.length)),
      ),
  );
}
