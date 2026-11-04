import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { dataDirectoryFsCode } from "./dataDirectoryTypes.js";

export async function readDataDirectoryJson(path: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (dataDirectoryFsCode(error) === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(raw) as unknown;
}

/** 控制文件先持久化再原子替换；复制中断不能留下半个有效启动指针。 */
export async function writeDataDirectoryJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    // Windows 不支持通过目录句柄 fsync；文件内容仍在 rename 前完成 flush。
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
