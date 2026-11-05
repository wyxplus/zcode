/** 迁移必须同时证明资源已持久化关闭和进程已退出；普通退出的强杀兜底不是成功凭证。 */
export interface DataMigrationChildProcess {
  readonly pid: number | undefined;
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  removeListener(event: "message", listener: (message: unknown) => void): unknown;
  removeListener(event: "exit", listener: (code: number) => void): unknown;
}

export function requestDataMigrationBarrier(
  child: DataMigrationChildProcess,
  options: { requestId: string; requestType: string; responseType: string; timeoutMs?: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const message = raw as Record<string, unknown>;
      if (message.type !== options.responseType || message.requestId !== options.requestId) return;
      finish(
        message.ok === true
          ? undefined
          : new Error(
              typeof message.error === "string"
                ? message.error
                : "Data migration reservation failed",
            ),
      );
    };
    const onExit = () =>
      finish(new Error("Data migration owner exited before reservation acknowledgement"));
    const timer = setTimeout(
      () => finish(new Error("Data migration reservation timed out")),
      options.timeoutMs ?? 30_000,
    );
    child.on("message", onMessage);
    child.on("exit", onExit);
    try {
      child.postMessage({ type: options.requestType, requestId: options.requestId });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function closeProcessForDataMigration(
  child: DataMigrationChildProcess,
  options: {
    requestId: string;
    prepareType: string;
    responseType: string;
    exitType: string;
    timeoutMs?: number;
  },
): Promise<void> {
  // Electron 的 exit 回调会清空 pid；必须在请求关闭前捕获原进程，不能事后读取。
  const pid = child.pid;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return Promise.reject(new Error("Data migration process PID is unavailable"));
  }
  return new Promise((resolve, reject) => {
    let cleanlyClosed = false;
    let settled = false;
    let exitObserved = false;
    let processExitTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(processExitTimer);
      child.removeListener("message", onMessage);
      child.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const confirmSystemExit = () => {
      if (settled) return;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") finish();
        else finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      // Windows UtilityProcess 的 exit 通知可能早于 OS 退出，立即扫租约会误判仍占用。
      // 只在原关闭时限内等待真实退出；不靠固定延迟放行，也不强杀或忽略存活租约。
      processExitTimer = setTimeout(confirmSystemExit, 50);
    };
    const onMessage = (raw: unknown) => {
      if (settled || cleanlyClosed) return;
      if (!raw || typeof raw !== "object") return;
      const message = raw as Record<string, unknown>;
      if (message.type !== options.responseType || message.requestId !== options.requestId) return;
      if (message.ok !== true) {
        finish(
          new Error(
            typeof message.error === "string"
              ? message.error
              : "Data migration clean shutdown failed",
          ),
        );
        return;
      }
      cleanlyClosed = true;
      try {
        child.postMessage({ type: options.exitType });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onExit = (code: number) => {
      if (settled || exitObserved) return;
      exitObserved = true;
      if (!cleanlyClosed || code !== 0) {
        finish(new Error(`Data migration clean shutdown not confirmed (exit=${code})`));
        return;
      }
      confirmSystemExit();
    };
    const timer = setTimeout(
      () => finish(new Error("Data migration clean shutdown timed out")),
      options.timeoutMs ?? 30_000,
    );
    child.on("message", onMessage);
    child.on("exit", onExit);
    try {
      child.postMessage({ type: options.prepareType, requestId: options.requestId });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** scheduler 可能已经接受 manual claim；必须先证明派发已闲置，再封闭接收它的 Hosts。 */
export async function reserveDataMigrationOwners(options: {
  reserveScheduler: () => Promise<void>;
  reserveHosts: Array<() => Promise<void>>;
}): Promise<void> {
  await options.reserveScheduler();
  const results = await Promise.allSettled(options.reserveHosts.map((reserve) => reserve()));
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

/** 恢复顺序反向：接收端全部恢复后才能让 scheduler 接受新的派发。 */
export async function cancelDataMigrationOwners(options: {
  cancelScheduler: () => Promise<void>;
  cancelHosts: Array<() => Promise<void>>;
}): Promise<void> {
  const results = await Promise.allSettled(options.cancelHosts.map((cancel) => cancel()));
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  await options.cancelScheduler();
}
