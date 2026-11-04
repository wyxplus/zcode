import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, dialog } from "electron";
import { abortDataDirectoryMigration } from "@zcode/services/data-directory";

/** 原生选择框需要 ready；维护进程只打开临时 profile，随后冷启，始终不打开业务数据。 */
export async function scheduleDataDirectoryRecovery(
  homeDir: string,
  migrationId: string,
  error: unknown,
): Promise<void> {
  const temporaryProfile = await mkdtemp(join(tmpdir(), "zcode-data-recovery-"));
  app.setPath("userData", temporaryProfile);
  app.setPath("sessionData", temporaryProfile);
  // 此处只能注册回调。入口的顶层 await 必须先结束，Electron 才会发出 ready。
  void app.whenReady().then(async () => {
    try {
      while (true) {
        const { response } = await dialog.showMessageBox({
          type: "error",
          title: "ZCode · Data directory",
          message:
            "数据目录迁移未完成，原有数据已保留。\nData migration did not finish. Your original data is retained.",
          detail: error instanceof Error ? error.message : String(error),
          buttons: ["重试 / Retry", "取消迁移并启动原目录 / Use original", "退出 / Exit"],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
        });
        if (response === 2) {
          app.quit();
          return;
        }
        if (response === 1) {
          try {
            // 引擎在 locator 已提交时拒绝取消，绝不把新写入回退到旧副本。
            await abortDataDirectoryMigration(homeDir, migrationId);
          } catch (abortError) {
            error = abortError;
            continue;
          }
        }
        app.relaunch();
        app.quit();
        return;
      }
    } catch (recoveryError) {
      dialog.showErrorBox("ZCode data directory", String(recoveryError));
      app.exit(1);
    }
  });
}
