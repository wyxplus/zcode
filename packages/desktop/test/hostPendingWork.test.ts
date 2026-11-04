import { describe, expect, it, vi } from "vitest";
import { HostPendingWork } from "../src/host/hostPendingWork.js";
import { startManualClaimHeartbeat } from "../src/host/cronRunLifecycle.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Host migration background persistence barrier", () => {
  it("refuses migration after a terminal event until snapshot lookup and terminal write both finish", async () => {
    const work = new HostPendingWork();
    const snapshot = deferred();
    const persist = deferred();
    const terminalWrite = vi.fn(async () => {
      await persist.promise;
    });
    const settled = work.track(async () => {
      await snapshot.promise;
      await terminalWrite();
    });
    // 此时 Agent 已 idle、父消息已返回，但终态尚未进入数据库，不能关闭 repo 后 ACK。
    expect(() => work.assertIdle()).toThrow("DATA_DIRECTORY_BUSY");
    snapshot.resolve();
    await vi.waitFor(() => expect(terminalWrite).toHaveBeenCalledOnce());
    expect(() => work.assertIdle()).toThrow("DATA_DIRECTORY_BUSY");
    persist.resolve();
    await settled;
    expect(() => work.assertIdle()).not.toThrow();
  });

  it("keeps unrelated writes pending when another operation fails", async () => {
    const work = new HostPendingWork();
    const write = deferred();
    const pending = work.track(() => write.promise);
    await expect(
      work.track(async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");
    expect(() => work.assertIdle()).toThrow("BUSY");
    write.resolve();
    await pending;
    expect(() => work.assertIdle()).not.toThrow();
  });

  it("retains an in-flight claim heartbeat after the interval is stopped", async () => {
    vi.useFakeTimers();
    try {
      const work = new HostPendingWork();
      const write = deferred();
      const heartbeat = startManualClaimHeartbeat({
        automationId: "automation",
        runId: "run",
        workspaceKey: "workspace",
        repo: { touchManualClaim: () => write.promise },
        logWarn: vi.fn(),
        intervalMs: 10,
        trackWork: (run) => work.track(run),
      });
      await vi.advanceTimersByTimeAsync(10);
      heartbeat.dispose();
      expect(() => work.assertIdle()).toThrow("BUSY");
      write.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(() => work.assertIdle()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
