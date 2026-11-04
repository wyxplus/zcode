import { copyFile, lstat, mkdir, open, readFile, readlink, stat, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { hashFile } from "./io.js";
import { copyDatabase, rewriteDatabasePaths, validateDatabaseReferences } from "./sqlite.js";
import {
  rewriteKnownJsonFile,
  rewriteManagedPath,
  rewriteWorkspaceDirectories,
} from "./transforms.js";
import { migrationError, type MigrationFile, type MigrationPathMapping } from "./types.js";
import { validateManagedReferences, validateMigratedCredentials } from "./validation.js";

const isManagedDatabase = (relativePath: string) =>
  ["cli/db/db.sqlite", "v2/tasks-index.sqlite"].includes(relativePath.replaceAll("\\", "/"));

export async function copyAndVerifyMigrationFiles(
  files: MigrationFile[],
  stagingRoot: string,
  finalRoot: string,
  mappings: MigrationPathMapping[],
): Promise<void> {
  const workspaceMoves = new Map<string, string>();
  for (const entry of files) {
    const target = join(stagingRoot, entry.relativePath);
    if (entry.kind === "directory") {
      await mkdir(target, { recursive: true, mode: entry.mode });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    if (entry.kind === "symlink") {
      const link = entry.linkTarget!;
      const absoluteLink = isAbsolute(link) ? link : resolve(dirname(entry.source), link);
      const mappedLink = rewriteManagedPath(absoluteLink, mappings);
      const linkInfo = await stat(entry.source);
      const type = linkInfo.isDirectory()
        ? process.platform === "win32"
          ? "junction"
          : "dir"
        : "file";
      // 不能沿用旧迁移“复制不了就跳过链接”的行为；创建失败必须阻断提交。
      await symlink(mappedLink, target, type);
      if (resolve(await readlink(target)) !== resolve(mappedLink))
        migrationError("INTEGRITY", `链接校验失败：${entry.relativePath}`);
      continue;
    }
    if (entry.kind === "sqlite") await copyDatabase(entry.source, target);
    else {
      await copyFile(entry.source, target, constants.COPYFILE_EXCL);
      if ((await hashFile(target)) !== entry.hash)
        migrationError("INTEGRITY", `文件复制校验失败：${entry.relativePath}`);
    }
    if ((await hashFile(entry.source)) !== entry.hash)
      migrationError("SOURCE_CHANGED", `停写后来源仍发生变化：${entry.relativePath}`);
    const handle = await open(target, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    // 未知用户/插件数据库已归为普通文件；Electron SQLite 只备份，路径改写仅限产品的两份 schema。
    if (entry.kind === "sqlite" && isManagedDatabase(entry.relativePath)) {
      for (const [oldPath, newPath] of rewriteDatabasePaths(target, mappings))
        workspaceMoves.set(oldPath, newPath);
    } else if (entry.relativePath.endsWith(".json")) {
      for (const [oldPath, newPath] of await rewriteKnownJsonFile(
        target,
        entry.relativePath,
        finalRoot,
        mappings,
      ))
        workspaceMoves.set(oldPath, newPath);
    }
  }
  // 先复制完全部文件再调整 path-derived 目录，避免后续复制重新创建旧 hash 目录。
  await rewriteWorkspaceDirectories(stagingRoot, workspaceMoves);
  await validateMigratedCredentials(stagingRoot);
  for (const entry of files) {
    const name = entry.relativePath.replaceAll("\\", "/");
    if (entry.kind === "sqlite" && isManagedDatabase(entry.relativePath))
      await validateDatabaseReferences(
        join(stagingRoot, entry.relativePath),
        stagingRoot,
        finalRoot,
      );
    if (
      name === "cli/plugins/installed_plugins.json" ||
      /^cli\/agents\/.+\/metadata\.json$/u.test(name)
    ) {
      const value = JSON.parse(await readFile(join(stagingRoot, entry.relativePath), "utf8"));
      await validateManagedReferences(value, stagingRoot, finalRoot);
    }
  }
  for (const entry of files) {
    const sourceStat = await lstat(entry.source);
    if (
      entry.kind === "file" &&
      (sourceStat.size !== entry.size || (await hashFile(entry.source)) !== entry.hash)
    ) {
      migrationError("SOURCE_CHANGED", `校验期间来源仍发生变化：${entry.relativePath}`);
    }
  }
}
