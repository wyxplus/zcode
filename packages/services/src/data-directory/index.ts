import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename, rm, statfs } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  assertDataDirectoryUnused,
  beginDataDirectoryMaintenance,
  commitDataDirectoryLocator,
  endDataDirectoryMaintenance,
  getDataDirectoryControlPaths,
  readDataDirectoryLocator,
  writeDataDirectoryRootMarker,
  type DataDirectoryLocator,
} from "@zcode/shared/data-directory";
import { acquireFileLock } from "@zcode/shared/node";
import { validateDataBaseDirTarget } from "../paths.js";
import { copyAndVerifyMigrationFiles } from "./copy.js";
import {
  durableJson,
  flushMigrationTree,
  isWithin,
  readJson,
  safeRelativePath,
  syncDirectory,
} from "./io.js";
import { inventoryMigrationSources } from "./inventory.js";
import { readMigrationJournal, writeMigrationJournal } from "./journal.js";
import {
  migrationError,
  type DataDirectoryMigrationPlan,
  type DataDirectorySource,
  type MigrationFile,
} from "./types.js";

export { discoverLegacyDataDirectorySources } from "./discovery.js";
export { DataDirectoryMigrationError } from "./types.js";
export type { DataDirectoryMigrationPlan, DataDirectorySource } from "./types.js";

async function assertEmptyTarget(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    migrationError("INVALID_TARGET", "请选择真实的空文件夹");
  if ((await readdir(path)).length > 0)
    migrationError("TARGET_NOT_EMPTY", "迁移目标必须是空文件夹（包括隐藏文件）");
}

async function withMigrationLock<T>(homeDir: string, run: () => Promise<T>): Promise<T> {
  const path = join(getDataDirectoryControlPaths(homeDir).directory, "migration-worker");
  await mkdir(getDataDirectoryControlPaths(homeDir).directory, { recursive: true });
  const release = await acquireFileLock(path, [25, 50, 100, 200], 100, 1_000);
  try {
    return await run();
  } finally {
    await release();
  }
}

export async function prepareDataDirectoryMigration(input: {
  homeDir: string;
  targetBaseDir: string;
  sources: DataDirectorySource[];
  electronProfileLayouts?: Record<string, "root" | "session">;
  windowsAppInstallDir?: string;
}): Promise<DataDirectoryMigrationPlan> {
  return withMigrationLock(input.homeDir, async () => {
    const pending = await readMigrationJournal(input.homeDir);
    if (pending && pending.phase !== "committed" && pending.phase !== "cancelled")
      migrationError("IN_PROGRESS", "已有未完成的数据迁移");
    await assertEmptyTarget(input.targetBaseDir);
    const targetBaseDir = await realpath(input.targetBaseDir);
    const validation = validateDataBaseDirTarget(targetBaseDir, {
      appInstallDir: input.windowsAppInstallDir,
    });
    if (!validation.ok)
      migrationError("INVALID_TARGET", "不能把数据迁移到 ZCode 安装目录或其子目录");
    const sources: DataDirectorySource[] = [];
    for (const source of input.sources) {
      safeRelativePath(source.targetRelativePath);
      for (const exclusion of source.exclude ?? []) safeRelativePath(exclusion);
      const canonical = await realpath(source.sourcePath);
      if (isWithin(targetBaseDir, canonical) || isWithin(canonical, targetBaseDir))
        migrationError("INVALID_TARGET", "来源与目标不能相同或互相包含");
      sources.push({
        ...source,
        sourcePath: resolve(source.sourcePath),
        canonicalSourcePath: canonical,
      });
    }
    if (sources.length === 0) migrationError("INVALID_SOURCE", "没有可迁移的数据来源");
    const id = randomUUID();
    const plan: DataDirectoryMigrationPlan = {
      version: 1,
      id,
      phase: "prepared",
      homeDir: resolve(input.homeDir),
      targetBaseDir,
      targetRoot: join(targetBaseDir, ".zcode"),
      stagingRoot: join(targetBaseDir, ".zcode-migration-" + id),
      previousLocator: await readDataDirectoryLocator(input.homeDir),
      sources,
      createdAt: Date.now(),
      preparingPid: process.pid,
      electronProfileLayouts: input.electronProfileLayouts,
      windowsAppInstallDir: input.windowsAppInstallDir,
    };
    // reserve 尚未证明全部 owner 空闲；此时封 gate 会阻断已接受工作创建 Agent，不能提前停写。
    await writeMigrationJournal(plan);
    return plan;
  });
}

async function readPreparedPlan(
  homeDir: string,
  migrationId: string,
): Promise<DataDirectoryMigrationPlan> {
  const plan = await readMigrationJournal(homeDir);
  if (!plan || plan.id !== migrationId || plan.phase !== "prepared")
    migrationError("NOT_READY", "迁移未处于等待停写确认状态");
  return plan;
}

/** 生命周期 owner 完成全部 reserve 后、关闭进程前，才封闭跨进程 admission。 */
export async function activateDataDirectoryMigrationMaintenance(
  homeDir: string,
  migrationId: string,
): Promise<void> {
  await withMigrationLock(homeDir, async () => {
    const plan = await readPreparedPlan(homeDir, migrationId);
    await beginDataDirectoryMaintenance({ homeDir: plan.homeDir, migrationId: plan.id });
  });
}

/** 自动恢复只能取消已退出 owner 的 prepared；不能由另一个新实例中断正在进行的 reserve。 */
export async function assertPreparedDataDirectoryMigrationOwnerExited(
  homeDir: string,
  migrationId: string,
): Promise<void> {
  await withMigrationLock(homeDir, async () => {
    const plan = await readPreparedPlan(homeDir, migrationId);
    try {
      process.kill(plan.preparingPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      // 无权检查不等于进程已退出，PID 重用也必须保守阻止自动取消。
    }
    migrationError(
      "PREPARING_OWNER_ALIVE",
      "另一个 ZCode 实例正在准备迁移，请等待该实例完成或在原实例取消",
    );
  });
}

export async function readPendingDataDirectoryMigration(
  homeDir: string,
): Promise<DataDirectoryMigrationPlan | null> {
  const plan = await readMigrationJournal(homeDir);
  return plan?.phase === "cancelled" ? null : plan;
}

/** 只有生命周期 owner 获得所有干净关闭 ACK 后，才允许把 prepared 推进为 ready。 */
export async function markDataDirectoryMigrationReady(
  homeDir: string,
  migrationId: string,
): Promise<void> {
  await withMigrationLock(homeDir, async () => {
    const plan = await readPreparedPlan(homeDir, migrationId);
    // activate 幂等；即使调用者遗漏显式 activate，也不能产生无 maintenance gate 的 ready。
    await beginDataDirectoryMaintenance({ homeDir: plan.homeDir, migrationId: plan.id });
    plan.phase = "ready";
    await writeMigrationJournal(plan);
  });
}

const fingerprint = (files: MigrationFile[]) =>
  JSON.stringify(
    files
      .map(({ relativePath, kind, hash, walHash, linkTarget }) => ({
        relativePath,
        kind,
        hash,
        walHash,
        linkTarget,
      }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
  );

async function verifyPreparedTarget(plan: DataDirectoryMigrationPlan, root: string): Promise<void> {
  if (!plan.targetManifest || !plan.sourceManifest)
    migrationError("INVALID_JOURNAL", "缺少迁移校验清单");
  const files = await inventoryMigrationSources([
    {
      sourcePath: root,
      targetRelativePath: "",
      exclude: [".data-root.json", ".migration-owner.json"],
    },
  ]);
  if (fingerprint(files) !== fingerprint(plan.targetManifest))
    migrationError("INTEGRITY", "目标文件与迁移校验清单不一致");
  const currentSources = await inventoryMigrationSources(plan.sources);
  if (fingerprint(currentSources) !== fingerprint(plan.sourceManifest))
    migrationError("SOURCE_CHANGED", "迁移停写后来源发生变化");
}

async function execute(plan: DataDirectoryMigrationPlan): Promise<DataDirectoryLocator> {
  const active = await readDataDirectoryLocator(plan.homeDir);
  if (active?.generation === plan.id) {
    // 指针已提交而 journal 尚未落盘的崩溃窗口，只补齐状态，绝不把新数据回退到旧副本。
    plan.phase = "committed";
    await writeMigrationJournal(plan);
    await endDataDirectoryMaintenance({ homeDir: plan.homeDir, migrationId: plan.id });
    return active;
  }
  if (plan.phase === "prepared" || plan.phase === "cancelled")
    migrationError("NOT_READY", "没有完整的停写确认，不能迁移");
  if (plan.phase === "committed")
    migrationError("INVALID_JOURNAL", "迁移提交记录与当前数据根不一致");
  await assertDataDirectoryUnused(plan.homeDir);
  for (const source of plan.sources) {
    if (
      source.canonicalSourcePath &&
      (await realpath(source.sourcePath)) !== source.canonicalSourcePath
    )
      migrationError("SOURCE_CHANGED", "来源目录的物理位置发生变化");
  }
  if (
    (await realpath(plan.targetBaseDir)) !== plan.targetBaseDir ||
    !validateDataBaseDirTarget(plan.targetBaseDir, { appInstallDir: plan.windowsAppInstallDir }).ok
  ) {
    migrationError("INVALID_TARGET", "目标目录位置发生变化或位于应用安装目录中");
  }
  const expectedGeneration = plan.previousLocator?.generation ?? null;
  if ((active?.generation ?? null) !== expectedGeneration)
    migrationError("SOURCE_CHANGED", "当前数据根已变化");
  if (plan.phase !== "verified") {
    const entries = await readdir(plan.targetBaseDir);
    if (
      plan.phase === "copying" &&
      entries.length === 1 &&
      entries[0] === basename(plan.stagingRoot)
    ) {
      // 只删除由本 journal 独占的 staging；绝不清空用户选择的目标目录。
      const marker = (await readJson(join(plan.stagingRoot, ".migration-owner.json"))) as {
        id?: unknown;
      } | null;
      if (marker?.id !== plan.id) migrationError("TARGET_NOT_EMPTY", "目标临时目录不属于当前迁移");
      await rm(plan.stagingRoot, { recursive: true });
    }
    await assertEmptyTarget(plan.targetBaseDir);
    const files = await inventoryMigrationSources(plan.sources);
    if (files.some((entry) => entry.relativePath === ".migration-owner.json"))
      migrationError("SOURCE_CONFLICT", "来源包含保留的迁移控制文件");
    if (
      files.some(
        (entry) =>
          entry.kind !== "directory" &&
          entry.relativePath.replaceAll("\\", "/").startsWith("server/service/"),
      ) ||
      (files.some((entry) => entry.relativePath.replaceAll("\\", "/") === "server/install.json") &&
        !files.some(
          (entry) => entry.relativePath.replaceAll("\\", "/") === "server/uninstalled.json",
        ))
    ) {
      migrationError(
        "REGISTERED_SERVICE",
        "请先卸载本机 ZCode Server 系统服务；服务注册含旧绝对路径，不能直接迁移",
      );
    }
    const disk = await statfs(plan.targetBaseDir, { bigint: true });
    const required = files.reduce(
      (bytes, file) => bytes + BigInt(file.size + (file.walSize ?? 0)),
      0n,
    );
    if (disk.bavail * disk.bsize < required + required / 10n)
      migrationError("INSUFFICIENT_SPACE", "目标磁盘没有足够的迁移空间");
    plan.phase = "copying";
    plan.sourceManifest = files;
    await writeMigrationJournal(plan);
    await mkdir(plan.stagingRoot, { mode: 0o700 });
    await durableJson(join(plan.stagingRoot, ".migration-owner.json"), { id: plan.id });
    const mappings = plan.sources.flatMap((source) =>
      [...new Set([source.sourcePath, source.canonicalSourcePath ?? source.sourcePath])].map(
        (path) => ({
          source: path,
          target: join(plan.targetRoot, source.targetRelativePath),
        }),
      ),
    );
    await copyAndVerifyMigrationFiles(files, plan.stagingRoot, plan.targetRoot, mappings);
    for (const [variant, sessionData] of Object.entries(plan.electronProfileLayouts ?? {})) {
      if (!/^[a-z][a-z0-9-]*$/u.test(variant) || !["root", "session"].includes(sessionData))
        migrationError("INVALID_PLAN", "无效的 Electron profile 布局");
      await durableJson(join(plan.stagingRoot, "desktop", variant, ".profile-layout.json"), {
        version: 1,
        sessionData,
      });
    }
    await flushMigrationTree(plan.stagingRoot);
    plan.targetManifest = await inventoryMigrationSources([
      {
        sourcePath: plan.stagingRoot,
        targetRelativePath: "",
        exclude: [".data-root.json", ".migration-owner.json"],
      },
    ]);
    plan.phase = "verified";
    await writeMigrationJournal(plan);
  }
  const rootExists = await lstat(plan.targetRoot).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  const root = rootExists ? plan.targetRoot : plan.stagingRoot;
  const allowedEntry = basename(root);
  if ((await readdir(plan.targetBaseDir)).some((entry) => entry !== allowedEntry))
    migrationError("TARGET_NOT_EMPTY", "迁移期间目标目录出现了其他文件");
  await verifyPreparedTarget(plan, root);
  await rm(join(root, ".migration-owner.json"), { force: true });
  await writeDataDirectoryRootMarker(root, plan.id);
  if (!rootExists) await rename(plan.stagingRoot, plan.targetRoot);
  // rename 与 active.json 位于不同目录；必须先持久化目标目录项再切换 locator。
  await syncDirectory(plan.targetBaseDir);
  const locator: DataDirectoryLocator = {
    version: 1,
    root: plan.targetRoot,
    generation: plan.id,
    committedAt: Date.now(),
  };
  await commitDataDirectoryLocator(locator, {
    homeDir: plan.homeDir,
    expectedGeneration,
    migrationId: plan.id,
  });
  plan.phase = "committed";
  await writeMigrationJournal(plan);
  await endDataDirectoryMaintenance({ homeDir: plan.homeDir, migrationId: plan.id });
  return locator;
}

export async function executeDataDirectoryMigration(
  homeDir: string,
): Promise<DataDirectoryLocator> {
  return withMigrationLock(homeDir, async () => {
    const plan = await readMigrationJournal(homeDir);
    if (!plan) migrationError("NOT_FOUND", "没有待执行的数据迁移");
    try {
      return await execute(plan);
    } catch (error) {
      plan.error = error instanceof Error ? error.message : String(error);
      await writeMigrationJournal(plan);
      throw error;
    }
  });
}

export async function abortDataDirectoryMigration(
  homeDir: string,
  migrationId: string,
): Promise<void> {
  await withMigrationLock(homeDir, async () => {
    const plan = await readMigrationJournal(homeDir);
    if (!plan || plan.id !== migrationId) migrationError("NOT_FOUND", "迁移记录不匹配");
    const active = await readDataDirectoryLocator(homeDir);
    if (plan.phase === "committed" || active?.generation === migrationId)
      migrationError("ALREADY_COMMITTED", "新数据根已提交；返回原位置必须重新完整迁移");
    plan.phase = "cancelled";
    await writeMigrationJournal(plan);
    await endDataDirectoryMaintenance({ homeDir, migrationId });
  });
}
