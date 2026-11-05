import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeProcessForDataMigration,
  requestDataMigrationBarrier,
  reserveDataMigrationOwners,
  cancelDataMigrationOwners,
} from "../src/main/desktopDataMigrationLifecycle.js";

class Child extends EventEmitter {
  pid: number | undefined = 12345;
  postMessage = vi.fn();
}

describe("data migration strict process shutdown", () => {
  beforeEach(() => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("需要匹配的干净关闭确认和真正的零退出码", async () => {
    const child = new Child();
    const closing = closeProcessForDataMigration(child, {
      requestId: "migration-1",
      prepareType: "prepare",
      responseType: "prepared",
      exitType: "exit",
      timeoutMs: 100,
    });
    child.emit("message", { type: "prepared", requestId: "stale", ok: true });
    expect(child.postMessage).toHaveBeenCalledTimes(1);
    child.emit("message", { type: "prepared", requestId: "migration-1", ok: true });
    expect(child.postMessage).toHaveBeenLastCalledWith({ type: "exit" });
    child.emit("exit", 0);
    await closing;
  });

  it("没有确认就退出不能当作迁移准备完成", async () => {
    const child = new Child();
    const closing = closeProcessForDataMigration(child, {
      requestId: "migration-2",
      prepareType: "prepare",
      responseType: "prepared",
      exitType: "exit",
    });
    child.emit("exit", 0);
    await expect(closing).rejects.toThrow("clean shutdown");
  });

  it("超时和资源关闭失败必须拒绝，不强杀后继续迁移", async () => {
    const child = new Child();
    const closing = closeProcessForDataMigration(child, {
      requestId: "migration-3",
      prepareType: "prepare",
      responseType: "prepared",
      exitType: "exit",
      timeoutMs: 5,
    });
    await expect(closing).rejects.toThrow("timed out");
    expect(child.postMessage).toHaveBeenCalledTimes(1);
    const failed = closeProcessForDataMigration(child, {
      requestId: "migration-4",
      prepareType: "prepare",
      responseType: "prepared",
      exitType: "exit",
    });
    child.emit("message", { type: "prepared", requestId: "migration-4", ok: false, error: "busy" });
    await expect(failed).rejects.toThrow("busy");
    expect(child.listenerCount("message")).toBe(0);
  });

  it("Electron 提前报告 exit 时，等待捕获的系统 PID 消失后才允许迁移", async () => {
    vi.useFakeTimers();
    const probe = vi.mocked(process.kill).mockReturnValue(true);
    const child = new Child();
    let completed = false;
    const closing = closeProcessForDataMigration(child, {
      requestId: "windows-exit",
      prepareType: "prepare",
      responseType: "prepared",
      exitType: "exit",
      timeoutMs: 1_000,
    }).then(() => {
      completed = true;
    });
    child.emit("message", { type: "prepared", requestId: "windows-exit", ok: true });
    // Electron 在 exit 回调前清空 pid，屏障必须保留关闭前的原 PID。
    child.pid = undefined;
    child.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(200);
    expect(completed).toBe(false);
    expect(probe).toHaveBeenCalledWith(12345, 0);
    expect(probe.mock.calls.every(([pid, signal]) => pid === 12345 && signal === 0)).toBe(true);
    probe.mockImplementation(() => {
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    });
    await vi.advanceTimersByTimeAsync(100);
    await closing;
    expect(completed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("系统进程一直存活时超时拒绝，迟到确认不能重启关闭或探测", async () => {
    vi.useFakeTimers();
    const probe = vi.mocked(process.kill).mockReturnValue(true);
    const child = new Child();
    const closing = closeProcessForDataMigration(child, {
      requestId: "still-alive",
      prepareType: "prepare",
      responseType: "prepared",
      exitType: "exit",
      timeoutMs: 250,
    });
    const rejected = expect(closing).rejects.toThrow("timed out");
    child.emit("message", { type: "prepared", requestId: "still-alive", ok: true });
    child.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(250);
    await rejected;
    const probesAtTimeout = probe.mock.calls.length;
    child.emit("message", { type: "prepared", requestId: "still-alive", ok: true });
    child.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledTimes(probesAtTimeout);
    expect(child.postMessage).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("无权探测系统进程不能冒充已经退出", async () => {
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
    });
    const child = new Child();
    const closing = closeProcessForDataMigration(child, {
      requestId: "probe-denied",
      prepareType: "prepare",
      responseType: "prepared",
      exitType: "exit",
    });
    child.emit("message", { type: "prepared", requestId: "probe-denied", ok: true });
    child.emit("exit", 0);
    await expect(closing).rejects.toThrow("Operation not permitted");
    expect(child.listenerCount("message")).toBe(0);
  });

  it("连续两次关闭隔离 PID 和计时器，重复 ACK 不重复发退出命令", async () => {
    vi.useFakeTimers();
    const alive = new Set<number>([12345, 23456]);
    const probe = vi.mocked(process.kill).mockImplementation((pid) => {
      if (alive.has(pid)) return true;
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    });
    for (const pid of [12345, 23456]) {
      const child = new Child();
      child.pid = pid;
      const options = {
        requestId: `migration-${pid}`,
        prepareType: "prepare",
        responseType: "prepared",
        exitType: "exit",
        timeoutMs: 1_000,
      };
      const closing = closeProcessForDataMigration(child, options);
      child.emit("message", { type: "prepared", requestId: options.requestId, ok: true });
      child.emit("message", { type: "prepared", requestId: options.requestId, ok: true });
      child.emit("exit", 0);
      child.emit("exit", 0);
      await vi.advanceTimersByTimeAsync(100);
      expect(child.postMessage).toHaveBeenCalledTimes(2);
      alive.delete(pid);
      await vi.advanceTimersByTimeAsync(100);
      await closing;
      expect(vi.getTimerCount()).toBe(0);
      expect(probe.mock.calls.every(([observed]) => observed === pid)).toBe(true);
      probe.mockClear();
    }
  });

  it("exit 通知不能延长本轮关闭的总时限", async () => {
    vi.useFakeTimers();
    vi.mocked(process.kill).mockReturnValue(true);
    const child = new Child();
    const closing = closeProcessForDataMigration(child, {
      requestId: "deadline",
      prepareType: "prepare",
      responseType: "prepared",
      exitType: "exit",
      timeoutMs: 1_000,
    });
    const rejected = expect(closing).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(900);
    child.emit("message", { type: "prepared", requestId: "deadline", ok: true });
    child.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("PID 缺失时拒绝关闭请求，非零退出码不能靠 PID 消失放行", async () => {
    const options = {
      requestId: "invalid-exit",
      prepareType: "prepare",
      responseType: "prepared",
      exitType: "exit",
    };
    const missing = new Child();
    missing.pid = undefined;
    await expect(closeProcessForDataMigration(missing, options)).rejects.toThrow("PID");
    expect(missing.postMessage).not.toHaveBeenCalled();
    const child = new Child();
    const closing = closeProcessForDataMigration(child, options);
    child.emit("message", { type: "prepared", requestId: options.requestId, ok: true });
    child.emit("exit", 1);
    await expect(closing).rejects.toThrow("exit=1");
    expect(process.kill).not.toHaveBeenCalled();
  });
});

describe("reversible migration reservation", () => {
  it("acknowledges reserve without asking the process to close or exit", async () => {
    const child = new Child();
    const reserved = requestDataMigrationBarrier(child, {
      requestId: "id",
      requestType: "reserve",
      responseType: "reserved",
    });
    child.emit("message", { type: "reserved", requestId: "id", ok: true });
    await reserved;
    expect(child.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "reserve", requestId: "id" });
    expect(child.listenerCount("exit")).toBe(0);
  });
  it("propagates busy without stopping the live child", async () => {
    const child = new Child();
    const reserved = requestDataMigrationBarrier(child, {
      requestId: "id",
      requestType: "reserve",
      responseType: "reserved",
    });
    child.emit("message", {
      type: "reserved",
      requestId: "id",
      ok: false,
      error: "DATA_DIRECTORY_BUSY",
    });
    await expect(reserved).rejects.toThrow("DATA_DIRECTORY_BUSY");
    expect(child.postMessage).toHaveBeenCalledTimes(1);
    expect(child.listenerCount("message")).toBe(0);
  });
});

describe("scheduler and Host migration ordering", () => {
  it("keeps Hosts open while an accepted scheduler dispatch is pending", async () => {
    let finishScheduler!: () => void;
    const reserveHost = vi.fn(async () => {});
    const reservation = reserveDataMigrationOwners({
      reserveScheduler: () =>
        new Promise<void>((resolve) => {
          finishScheduler = resolve;
        }),
      reserveHosts: [reserveHost],
    });
    expect(reserveHost).not.toHaveBeenCalled();
    finishScheduler();
    await reservation;
    expect(reserveHost).toHaveBeenCalledOnce();
  });
  it("does not seal any Host if scheduler reports an accepted claim", async () => {
    const reserveHost = vi.fn(async () => {});
    await expect(
      reserveDataMigrationOwners({
        reserveScheduler: async () => {
          throw new Error("Scheduler still has pending work");
        },
        reserveHosts: [reserveHost],
      }),
    ).rejects.toThrow("pending work");
    expect(reserveHost).not.toHaveBeenCalled();
  });
  it("keeps scheduler paused until every Host has unsealed", async () => {
    let finishHost!: () => void;
    const cancelScheduler = vi.fn(async () => {});
    const cancelling = cancelDataMigrationOwners({
      cancelScheduler,
      cancelHosts: [
        () =>
          new Promise<void>((resolve) => {
            finishHost = resolve;
          }),
      ],
    });
    expect(cancelScheduler).not.toHaveBeenCalled();
    finishHost();
    await cancelling;
    expect(cancelScheduler).toHaveBeenCalledOnce();
  });
});
