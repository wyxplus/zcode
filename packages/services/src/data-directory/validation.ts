import { access, lstat, readFile, readlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { credentialRecordSchema } from "@zcode/shared";
import { createCredentialCipherProvider } from "../credential/providers/credentialCipherProvider.js";
import { isWithin } from "./io.js";
import { migrationError } from "./types.js";

async function accessStagedPath(
  path: string,
  stagingRoot: string,
  finalRoot: string,
  depth = 0,
): Promise<void> {
  if (depth > 32) migrationError("MISSING_REFERENCE", "受管文件引用包含循环链接");
  if (!isWithin(path, stagingRoot)) {
    await access(path);
    return;
  }
  const parts = relative(stagingRoot, path).split(sep).filter(Boolean);
  let current = stagingRoot;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    if ((await lstat(current)).isSymbolicLink()) {
      const link = resolve(dirname(current), await readlink(current));
      const mapped = isWithin(link, finalRoot)
        ? join(stagingRoot, relative(finalRoot, link))
        : link;
      await accessStagedPath(
        join(mapped, ...parts.slice(index + 1)),
        stagingRoot,
        finalRoot,
        depth + 1,
      );
      return;
    }
  }
  await access(current);
}

/** 只验证受管的结构化引用；不把历史正文或外部项目路径当作迁移清单。 */
export async function validateManagedReferences(
  value: unknown,
  stagingRoot: string,
  finalRoot: string,
  parentKey = "",
): Promise<void> {
  if (typeof value === "string" && parentKey === "url" && value.startsWith("file://")) {
    await validateManagedReferences(fileURLToPath(value), stagingRoot, finalRoot, "localPath");
    return;
  }
  if (
    typeof value === "string" &&
    ["installPath", "localPath", "artifactPath", "outputFile", "taskOutputFile"].includes(
      parentKey,
    ) &&
    isWithin(value, finalRoot)
  ) {
    try {
      await accessStagedPath(join(stagingRoot, relative(finalRoot, value)), stagingRoot, finalRoot);
    } catch {
      migrationError("MISSING_REFERENCE", "迁移后的受管文件引用不可访问");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value)
      await validateManagedReferences(entry, stagingRoot, finalRoot, parentKey);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const fileRecord = ["file", "image", "pdf", "symbol"].includes(
      String(record.type ?? record.kind),
    );
    for (const [key, item] of Object.entries(value))
      await validateManagedReferences(
        item,
        stagingRoot,
        finalRoot,
        key === "path" && fileRecord ? "localPath" : key,
      );
  }
}

export async function validateMigratedCredentials(stagingRoot: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(join(stagingRoot, "v2", "credentials.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const values = credentialRecordSchema.parse(JSON.parse(raw));
    const cipher = createCredentialCipherProvider();
    // 解密仅证明原用户身份仍可读取；不记录、返回或重新保存任何明文。
    for (const value of Object.values(values)) cipher.decrypt(value);
  } catch {
    migrationError("CREDENTIALS_UNREADABLE", "现有登录凭据不能在当前用户身份下解密，迁移未提交");
  }
}
