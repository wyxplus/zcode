import { createHash } from "node:crypto";
import { lstat, readFile, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { durableJson, isWithin } from "./io.js";
import { migrationError, type MigrationPathMapping } from "./types.js";

export function rewriteManagedPath(value: string, mappings: MigrationPathMapping[]): string {
  if (!isAbsolute(value)) return value;
  for (const mapping of [...mappings].sort((a, b) => b.source.length - a.source.length)) {
    if (isWithin(value, mapping.source))
      return join(mapping.target, relative(mapping.source, value));
  }
  return value;
}

const PATH_KEYS = new Set([
  "workspacePath",
  "workspaceKey",
  "directory",
  "cwd",
  "repoRoot",
  "localPath",
  "filePath",
  "artifactPath",
  "outputFile",
  "taskOutputFile",
  "installPath",
  "canonicalServerRoot",
  "releaseDir",
]);
const REMOTE_WORKSPACE_KEYS = new Set([
  "workspacePath",
  "workspaceKey",
  "directory",
  "cwd",
  "repoRoot",
]);
const PATH_ARRAY_KEYS = new Set(["recentProjects"]);

export function rewriteStructuredPaths(
  value: unknown,
  mappings: MigrationPathMapping[],
  parentKey = "",
): unknown {
  if (typeof value === "string") {
    if (PATH_KEYS.has(parentKey) || PATH_ARRAY_KEYS.has(parentKey))
      return rewriteManagedPath(value, mappings);
    if (parentKey === "url" && value.startsWith("file://")) {
      const oldPath = fileURLToPath(value);
      const nextPath = rewriteManagedPath(oldPath, mappings);
      return nextPath === oldPath ? value : pathToFileURL(nextPath).href;
    }
    return value;
  }
  if (Array.isArray(value))
    return value.map((entry) => rewriteStructuredPaths(entry, mappings, parentKey));
  if (!value || typeof value !== "object") return value;
  if (parentKey === "lastActiveTaskByWorkspace") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const targetKey = rewriteManagedPath(key, mappings);
      if (Object.hasOwn(result, targetKey))
        migrationError("SOURCE_CONFLICT", "工作区恢复状态的路径键发生冲突");
      result[targetKey] = item;
    }
    return result;
  }
  const record = value as Record<string, unknown>;
  const remoteWorkspace =
    typeof record.workspaceIdentity === "string" && record.workspaceIdentity.trim().length > 0;
  const fileRecord = ["file", "image", "pdf", "symbol"].includes(
    String(record.type ?? record.kind),
  );
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      remoteWorkspace && REMOTE_WORKSPACE_KEYS.has(key)
        ? item
        : typeof item === "string" &&
            ((key === "path" && fileRecord) || (key === "root" && parentKey === "path"))
          ? rewriteManagedPath(item, mappings)
          : rewriteStructuredPaths(item, mappings, key),
    ]),
  );
}

function collectWorkspaceMoves(
  value: unknown,
  mappings: MigrationPathMapping[],
  result: Map<string, string>,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectWorkspaceMoves(entry, mappings, result);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (!(typeof record.workspaceIdentity === "string" && record.workspaceIdentity.trim())) {
    const paths = [
      record.workspacePath,
      ...(Array.isArray(record.recentProjects) ? record.recentProjects : []),
    ];
    for (const path of paths) {
      if (typeof path !== "string") continue;
      const target = rewriteManagedPath(path, mappings);
      if (target !== path) result.set(path, target);
    }
  }
  for (const item of Object.values(record)) collectWorkspaceMoves(item, mappings, result);
}

export async function rewriteKnownJsonFile(
  path: string,
  relativePath: string,
  finalRoot: string,
  mappings: MigrationPathMapping[],
): Promise<Map<string, string>> {
  const workspaceMoves = new Map<string, string>();
  const name = relativePath.split(sep).join("/");
  const settings = name === "v2/setting.json";
  const cliConfig = name === "cli/config.json";
  const knownFile =
    settings ||
    cliConfig ||
    name === "cli/plugins/installed_plugins.json" ||
    ["server/install.json", "server/current.json", "server/pending.json"].includes(name) ||
    /^cli\/agents\/.+\/metadata\.json$/u.test(name) ||
    /^v2\/checkpoints\/[a-f0-9]+\/[^/]+\.json$/u.test(name) ||
    /^v2\/session-bindings\/.+\.json$/u.test(name) ||
    /^v2\/sessions\/.+\.json$/u.test(name);
  // artifacts/*.json 是原始工具输出，允许数组、纯文本或任意用户字段，必须逐字保留。
  if (!knownFile) return workspaceMoves;
  const original = JSON.parse(await readFile(path, "utf8"));
  if (!original || typeof original !== "object" || Array.isArray(original))
    migrationError("INVALID_CONFIG", `无法迁移结构不明的配置：${relativePath}`);
  const updated = rewriteStructuredPaths(original, mappings) as Record<string, unknown>;
  collectWorkspaceMoves(original, mappings, workspaceMoves);
  if (settings) updated.dataBaseDir = dirname(finalRoot);
  if (cliConfig) {
    updated.storage = {
      ...(typeof updated.storage === "object" && updated.storage !== null ? updated.storage : {}),
      dir: finalRoot,
      sessionDbPath: join(finalRoot, "cli", "db", "db.sqlite"),
    };
  }
  await durableJson(path, updated);
  return workspaceMoves;
}

async function moveIfPresent(source: string, target: string): Promise<void> {
  if (source === target) return;
  try {
    await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    await lstat(target);
    migrationError("SOURCE_CONFLICT", "工作区身份迁移与已有目标目录冲突");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(source, target);
}

export async function rewriteWorkspaceDirectories(
  stagingRoot: string,
  moves: Map<string, string>,
): Promise<void> {
  for (const [source, target] of moves) {
    const oldHash = createHash("sha256").update(source).digest("hex").slice(0, 12);
    const newHash = createHash("sha256").update(target).digest("hex").slice(0, 12);
    for (const parent of [
      "v2/sessions",
      "v2/session-bindings",
      "v2/checkpoints",
      "v2/agent-config/claude",
    ]) {
      await moveIfPresent(join(stagingRoot, parent, oldHash), join(stagingRoot, parent, newHash));
    }
    // 保持 project memory 原来的路径键规则，远端 workspace identity 不进入此映射。
    const memoryName = (path: string) => {
      const normalized = resolve(path);
      const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
      const slug =
        basename(normalized)
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 48) || "project";
      return `${slug}-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
    };
    await moveIfPresent(
      join(stagingRoot, "cli/memories/projects", memoryName(source)),
      join(stagingRoot, "cli/memories/projects", memoryName(target)),
    );
  }
}
