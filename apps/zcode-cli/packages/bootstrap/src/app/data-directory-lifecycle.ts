import {
  acquireDataDirectoryUsageLease,
  assertUnifiedDataDirectoryEnvironment,
  resolveDataDirectoryHome,
  type DataDirectoryUsageLease,
} from "@zcode/shared/data-directory";

const processLeases = new Map<string, Promise<DataDirectoryUsageLease>>();

/** SDK 可以嵌入长活进程；普通 close 是 best-effort，租约保留至进程退出才安全。 */
export async function ensureAppDataDirectoryLease(env?: NodeJS.ProcessEnv): Promise<void> {
  const home = resolveDataDirectoryHome();
  // SDK 宿主的 beforeExit listener 可以再次启动业务；只能由死亡 PID 检查回收租约。
  let pending = processLeases.get(home);
  if (!pending) {
    pending = acquireDataDirectoryUsageLease({ homeDir: home, role: "sdk" });
    processLeases.set(home, pending);
    void pending.catch(() => {
      if (processLeases.get(home) === pending) processLeases.delete(home);
    });
  }
  await pending;
  assertUnifiedDataDirectoryEnvironment(env);
}
