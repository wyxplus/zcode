import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { getDataDirectoryControlPaths } from "@zcode/shared/data-directory";
import { durableJson, readJson, safeRelativePath } from "./io.js";
import { migrationError, type DataDirectoryMigrationPlan } from "./types.js";

const fileSchema = z.object({
  source: z.string(),
  relativePath: z.string(),
  kind: z.enum(["directory", "file", "symlink", "sqlite"]),
  size: z.number().nonnegative(),
  hash: z.string().optional(),
  walHash: z.string().optional(),
  walSize: z.number().nonnegative().optional(),
  linkTarget: z.string().optional(),
  mode: z.number(),
});
const journalSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  phase: z.enum(["prepared", "ready", "copying", "verified", "committed", "cancelled"]),
  homeDir: z.string(),
  targetBaseDir: z.string(),
  targetRoot: z.string(),
  stagingRoot: z.string(),
  previousLocator: z
    .object({
      version: z.literal(1),
      root: z.string(),
      generation: z.string(),
      committedAt: z.number(),
    })
    .nullable(),
  sources: z
    .array(
      z.object({
        sourcePath: z.string(),
        canonicalSourcePath: z.string().optional(),
        targetRelativePath: z.string(),
        exclude: z.array(z.string()).optional(),
      }),
    )
    .min(1),
  createdAt: z.number(),
  preparingPid: z.number().int().positive(),
  sourceManifest: z.array(fileSchema).optional(),
  targetManifest: z.array(fileSchema).optional(),
  error: z.string().optional(),
  electronProfileLayouts: z
    .record(z.string().regex(/^[a-z][a-z0-9-]*$/u), z.enum(["root", "session"]))
    .optional(),
  windowsAppInstallDir: z.string().optional(),
});

export async function readMigrationJournal(
  homeDir: string,
): Promise<DataDirectoryMigrationPlan | null> {
  const value = await readJson(getDataDirectoryControlPaths(homeDir).journal);
  if (value === null) return null;
  const parsed = journalSchema.safeParse(value);
  if (!parsed.success) migrationError("INVALID_JOURNAL", "迁移状态文件损坏，保留原数据并停止启动");
  const plan = parsed.data;
  if (
    resolve(plan.homeDir) !== resolve(homeDir) ||
    !isAbsolute(plan.targetBaseDir) ||
    plan.targetRoot !== join(plan.targetBaseDir, ".zcode") ||
    plan.stagingRoot !== join(plan.targetBaseDir, ".zcode-migration-" + plan.id)
  )
    migrationError("INVALID_JOURNAL", "迁移状态文件中的路径无效");
  for (const source of plan.sources) {
    if (!isAbsolute(source.sourcePath)) migrationError("INVALID_JOURNAL", "来源必须是绝对路径");
    if (source.canonicalSourcePath && !isAbsolute(source.canonicalSourcePath))
      migrationError("INVALID_JOURNAL", "物理来源必须是绝对路径");
    safeRelativePath(source.targetRelativePath);
    for (const excluded of source.exclude ?? []) safeRelativePath(excluded);
  }
  for (const file of [...(plan.sourceManifest ?? []), ...(plan.targetManifest ?? [])])
    safeRelativePath(file.relativePath);
  return plan;
}

export async function writeMigrationJournal(plan: DataDirectoryMigrationPlan): Promise<void> {
  await durableJson(getDataDirectoryControlPaths(plan.homeDir).journal, plan);
}
