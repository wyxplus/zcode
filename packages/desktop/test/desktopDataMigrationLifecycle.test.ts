import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  closeProcessForDataMigration,
  requestDataMigrationBarrier,
  reserveDataMigrationOwners,
  cancelDataMigrationOwners,
} from "../src/main/desktopDataMigrationLifecycle.js";

class Child extends EventEmitter {
  postMessage = vi.fn();
}

describe("data migration strict process shutdown", () => {
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
