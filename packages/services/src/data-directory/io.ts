import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { migrationError } from "./types.js";

export function isWithin(path: string, parent: string): boolean {
  const suffix = relative(parent, path);
  return (
    suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))
  );
}

export function safeRelativePath(value: string): string {
  if (isAbsolute(value) || value.split(/[\\/]/u).includes("..")) {
    migrationError("INVALID_PLAN", "迁移目录映射不能越过目标数据根");
  }
  return value;
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function durableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
    // Windows 不支持打开目录做 fsync；文件自身已 flush，重启仍须校验阶段与目标 marker。
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 先 flush 变换后的文件，再自底向上持久化目录项，不能先提交位于另一目录的 locator。 */
export async function flushMigrationTree(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    for (const name of await readdir(path)) await flushMigrationTree(join(path, name));
    await syncDirectory(path);
  } else {
    // Windows 的 FlushFileBuffers 要求可写句柄；只读打开会在提交前报 EPERM。
    // r+ 不截断已经校验的目标内容，且落盘失败仍必须阻止 locator 提交。
    const handle = await open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export function absolutePath(value: string, homeDir: string): string {
  return resolve(
    value.startsWith("~/") || value.startsWith("~\\") ? resolve(homeDir, value.slice(2)) : value,
  );
}
