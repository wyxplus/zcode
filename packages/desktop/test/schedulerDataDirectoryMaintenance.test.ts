import { describe, expect, it, vi } from "vitest";
import { createSchedulerDataDirectoryMaintenance } from "../src/scheduler/schedulerDataDirectoryMaintenance.js";

function setup(pending: boolean) {
  const options = {
    pause: vi.fn(),
    resume: vi.fn(),
    hasPendingWork: vi.fn(() => pending),
    close: vi.fn(),
    postMessage: vi.fn(),
    exit: vi.fn(),
  };
  return { options, maintenance: createSchedulerDataDirectoryMaintenance(options) };
}

describe("scheduler migration barrier", () => {
  it("pauses before checking pending claims and never acknowledges busy work as closed", () => {
    const { options, maintenance } = setup(true);
    maintenance.handleMessage({
      type: "scheduler-reserve-data-migration",
      requestId: "migration-1",
    });
    expect(options.pause.mock.invocationCallOrder[0]).toBeLessThan(
      options.hasPendingWork.mock.invocationCallOrder[0]!,
    );
    expect(options.close).not.toHaveBeenCalled();
    expect(options.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "migration-1", ok: false }),
    );
    maintenance.handleMessage({ type: "scheduler-exit-data-migration" });
    expect(options.exit).not.toHaveBeenCalled();
    maintenance.handleMessage({
      type: "scheduler-cancel-data-migration",
      requestId: "migration-1",
    });
    expect(options.resume).toHaveBeenCalledOnce();
    expect(maintenance.preparing).toBe(false);
    expect(options.close).not.toHaveBeenCalled();
  });

  it("requires successful reservation and strict close before ACK and waits for the exit command", () => {
    const { options, maintenance } = setup(false);
    maintenance.handleMessage({
      type: "scheduler-reserve-data-migration",
      requestId: "migration-1",
    });
    expect(options.close).not.toHaveBeenCalled();
    maintenance.handleMessage({
      type: "scheduler-prepare-data-migration",
      requestId: "migration-1",
    });
    expect(options.close).toHaveBeenCalledOnce();
    expect(options.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "migration-1", ok: true }),
    );
    expect(options.exit).not.toHaveBeenCalled();
    maintenance.handleMessage({ type: "scheduler-exit-data-migration" });
    expect(options.exit).toHaveBeenCalledOnce();
  });

  it("propagates a database close error and refuses migration exit", () => {
    const { options, maintenance } = setup(false);
    maintenance.handleMessage({
      type: "scheduler-reserve-data-migration",
      requestId: "migration-1",
    });
    options.close.mockImplementation(() => {
      throw new Error("SQLite close failed");
    });
    maintenance.handleMessage({
      type: "scheduler-prepare-data-migration",
      requestId: "migration-1",
    });
    expect(options.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: "SQLite close failed" }),
    );
    expect(maintenance.closed).toBe(false);
  });
});
