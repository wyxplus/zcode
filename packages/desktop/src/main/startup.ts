import { app, dialog } from "electron";
import {
  acquireDataDirectoryUsageLease,
  initializeDataDirectory,
  resolveDataDirectoryHome,
} from "@zcode/shared/data-directory";
import {
  abortDataDirectoryMigration,
  assertPreparedDataDirectoryMigrationOwnerExited,
  executeDataDirectoryMigration,
  readPendingDataDirectoryMigration,
} from "@zcode/services/data-directory";
import { scheduleDataDirectoryRecovery } from "./desktopDataDirectoryRecovery.js";

// 必须保留入口顶层 await：Electron ready 之前完成维护，不能先导入会打开 profile/日志/数据库的业务图。
try {
  const homeDir = resolveDataDirectoryHome();
  const pending = await readPendingDataDirectoryMigration(homeDir);
  let recovering = false;
  if (pending) {
    if (pending.phase === "prepared") {
      await assertPreparedDataDirectoryMigrationOwnerExited(homeDir, pending.id);
      await abortDataDirectoryMigration(homeDir, pending.id);
    } else {
      try {
        await executeDataDirectoryMigration(homeDir);
      } catch (error) {
        await scheduleDataDirectoryRecovery(homeDir, pending.id, error);
        recovering = true;
      }
    }
  }
  if (!recovering) {
    await initializeDataDirectory({ homeDir });
    await acquireDataDirectoryUsageLease({ role: "desktop-main", homeDir });
    await import("./index.js");
  }
} catch (error) {
  // 目标盘失联或维护校验失败时不能继续初始化默认 HOME，否则会制造一套空历史。
  dialog.showErrorBox(
    "ZCode data directory",
    `ZCode could not open its data directory. Your original data has been retained.\n\n${error instanceof Error ? error.message : String(error)}`,
  );
  app.exit(1);
}
