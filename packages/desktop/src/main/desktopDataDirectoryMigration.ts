import { isAbsolute, join, relative } from "node:path";
import {
  abortDataDirectoryMigration,
  activateDataDirectoryMigrationMaintenance,
  discoverLegacyDataDirectorySources,
  markDataDirectoryMigrationReady,
  prepareDataDirectoryMigration,
} from "@zcode/services/data-directory";
import { validateDataBaseDirTarget } from "@zcode/services/node";
import { getUnifiedDataRoot, listLiveDataDirectoryLeases } from "@zcode/shared/data-directory";

interface DesktopDataDirectoryMigrationOptions {
  homeDir: string;
  appBaseDir: string;
  appDataDir: string;
  userDataDir: string;
  sessionDataDir: string;
  variant: "development" | "preview" | "stable";
  targetBaseDir: string;
  windowsAppInstallDir?: string;
  includeSiblingProfiles?: boolean;
  reserveProcesses: (migrationId: string) => Promise<void>;
  cancelReservation: (migrationId: string) => Promise<void>;
  prepareProcesses: (migrationId: string) => Promise<void>;
  restart: () => Promise<void>;
  restartAfterFailure: (error: unknown) => Promise<void>;
}

/** Main 只调度关闭与重启；迁移 journal、复制、校验和 locator 提交由 services 维护入口唯一拥有。 */
export async function migrateDesktopDataDirectory(
  options: DesktopDataDirectoryMigrationOptions,
): Promise<void> {
  const validation = validateDataBaseDirTarget(options.targetBaseDir, {
    appInstallDir: options.windowsAppInstallDir,
  });
  if (!validation.ok) throw new Error(validation.code);
  const profiles = new Map([
    ["stable", join(options.appDataDir, "ZCode")],
    ["preview", join(options.appDataDir, "ZCode Preview")],
    ["development", join(options.appDataDir, "ZCode Dev")],
  ]);
  if (options.includeSiblingProfiles === false) profiles.clear();
  profiles.set(options.variant, options.userDataDir);
  const sources = await discoverLegacyDataDirectorySources({
    homeDir: options.homeDir,
    appBaseDir: options.appBaseDir,
    cliStorageRoot: process.env.ZCODE_STORAGE_DIR,
    sessionDbPath: process.env.ZCODE_SESSION_DB_PATH || process.env.ZCODE_SESSION_DB,
    electronProfiles: [...profiles].map(([variant, sourcePath]) => ({ sourcePath, variant })),
  });
  let electronProfileLayouts: Record<string, "root" | "session"> | undefined;
  if (!getUnifiedDataRoot(options.homeDir)) {
    electronProfileLayouts = {
      [options.variant]: options.sessionDataDir === options.userDataDir ? "root" : "session",
    };
    if (
      options.sessionDataDir !== options.userDataDir &&
      options.sessionDataDir !== join(options.userDataDir, "session")
    ) {
      const profile = sources.find(
        (source) => source.targetRelativePath === join("desktop", options.variant),
      );
      if (profile) {
        const sessionRelative = relative(options.userDataDir, options.sessionDataDir);
        profile.exclude = [
          ...(profile.exclude ?? []),
          "session",
          ...(!sessionRelative.startsWith("..") && !isAbsolute(sessionRelative)
            ? [sessionRelative]
            : []),
        ];
      }
      sources.push({
        sourcePath: options.sessionDataDir,
        targetRelativePath: join("desktop", options.variant, "session"),
      });
    }
  }
  // 空目录等可纠正错误在关闭任何进程前返回给设置页。
  const plan = await prepareDataDirectoryMigration({
    homeDir: options.homeDir,
    targetBaseDir: options.targetBaseDir,
    sources,
    electronProfileLayouts,
    windowsAppInstallDir: options.windowsAppInstallDir,
  });
  try {
    await options.reserveProcesses(plan.id);
    await activateDataDirectoryMigrationMaintenance(options.homeDir, plan.id);
  } catch (error) {
    // BUSY 仅取消可逆门禁，不退出进程、不清空或中断已 accepted 的输入。
    const rollbackErrors: unknown[] = [];
    try {
      await abortDataDirectoryMigration(options.homeDir, plan.id);
    } catch (abortError) {
      rollbackErrors.push(abortError);
    }
    try {
      await options.cancelReservation(plan.id);
    } catch (cancelError) {
      rollbackErrors.push(cancelError);
    }
    if (rollbackErrors.length)
      throw new AggregateError([error, ...rollbackErrors], "DATA_DIRECTORY_CANCEL_FAILED");
    throw error;
  }
  try {
    await options.prepareProcesses(plan.id);
    const otherOwners = (await listLiveDataDirectoryLeases(options.homeDir)).filter(
      (lease) => lease.pid !== process.pid,
    );
    if (otherOwners.length > 0) {
      throw new Error(
        "ZCODE_DATA_IN_USE: Other ZCode processes are still using this data directory",
      );
    }
    await markDataDirectoryMigrationReady(options.homeDir, plan.id);
  } catch (error) {
    // Host 已封闭 admission 后不尝试热恢复：取消尚未复制的计划，再冷启同一个旧根。
    let failure = error;
    try {
      await abortDataDirectoryMigration(options.homeDir, plan.id);
    } catch (abortError) {
      failure = new AggregateError(
        [error, abortError],
        "DATA_DIRECTORY_CANCEL_FAILED: Restart to recover the pending migration",
      );
    }
    // 此时已有资源真实关闭；即使 journal 无法取消，也需冷启由维护入口读取事实并恢复。
    await options.restartAfterFailure(failure);
    throw failure;
  }
  // 真正的复制在完整退出后的维护启动阶段进行，绝不复制仍被 Chromium 打开的 profile。
  await options.restart();
}
