import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  prepare: vi.fn(),
  activate: vi.fn(),
  ready: vi.fn(),
  abort: vi.fn(),
  leases: vi.fn(),
  root: vi.fn(),
  validate: vi.fn(),
}));
vi.mock("@zcode/services/data-directory", () => ({
  discoverLegacyDataDirectorySources: mocks.discover,
  prepareDataDirectoryMigration: mocks.prepare,
  markDataDirectoryMigrationReady: mocks.ready,
  abortDataDirectoryMigration: mocks.abort,
  activateDataDirectoryMigrationMaintenance: mocks.activate,
}));
vi.mock("@zcode/services/node", () => ({ validateDataBaseDirTarget: mocks.validate }));
vi.mock("@zcode/shared/data-directory", () => ({
  listLiveDataDirectoryLeases: mocks.leases,
  getUnifiedDataRoot: mocks.root,
}));
import { migrateDesktopDataDirectory } from "../src/main/desktopDataDirectoryMigration.js";

const options = () => ({
  homeDir: "/home",
  appBaseDir: "/home",
  appDataDir: "/appdata",
  userDataDir: "/profile",
  sessionDataDir: "/profile",
  variant: "stable" as const,
  targetBaseDir: "/destination",
  reserveProcesses: vi.fn(async () => {}),
  cancelReservation: vi.fn(async () => {}),
  prepareProcesses: vi.fn(async () => {}),
  restart: vi.fn(async () => {}),
  restartAfterFailure: vi.fn(async () => {}),
});

describe("desktop data directory lifecycle orchestration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.root.mockReturnValue(null);
    mocks.validate.mockReturnValue({ ok: true });
    mocks.discover.mockResolvedValue([
      { sourcePath: "/profile", targetRelativePath: join("desktop", "stable") },
    ]);
    mocks.prepare.mockResolvedValue({ id: "migration-1" });
    mocks.leases.mockResolvedValue([{ pid: process.pid }]);
  });

  it("rejects an invalid target before closing any process", async () => {
    const deps = options();
    mocks.prepare.mockRejectedValue(new Error("DATA_DIRECTORY_TARGET_NOT_EMPTY"));
    await expect(migrateDesktopDataDirectory(deps)).rejects.toThrow("TARGET_NOT_EMPTY");
    expect(deps.reserveProcesses).not.toHaveBeenCalled();
    expect(deps.prepareProcesses).not.toHaveBeenCalled();
    expect(deps.restartAfterFailure).not.toHaveBeenCalled();
  });

  it("records ready only after strict process close and then requests a full restart", async () => {
    const deps = options();
    await migrateDesktopDataDirectory(deps);
    expect(deps.reserveProcesses).toHaveBeenCalledWith("migration-1");
    expect(deps.prepareProcesses.mock.invocationCallOrder[0]).toBeGreaterThan(
      deps.reserveProcesses.mock.invocationCallOrder[0]!,
    );
    expect(deps.prepareProcesses).toHaveBeenCalledWith("migration-1");
    expect(mocks.activate.mock.invocationCallOrder[0]).toBeGreaterThan(
      deps.reserveProcesses.mock.invocationCallOrder[0]!,
    );
    expect(deps.prepareProcesses.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.activate.mock.invocationCallOrder[0]!,
    );
    expect(mocks.ready).toHaveBeenCalledWith("/home", "migration-1");
    expect(mocks.ready.mock.invocationCallOrder[0]).toBeGreaterThan(
      deps.prepareProcesses.mock.invocationCallOrder[0]!,
    );
    expect(deps.restart.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.ready.mock.invocationCallOrder[0]!,
    );
    expect(mocks.abort).not.toHaveBeenCalled();
  });

  it("unseals every owner after BUSY without closing or restarting accepted work", async () => {
    const deps = options();
    deps.reserveProcesses.mockRejectedValue(new Error("DATA_DIRECTORY_BUSY: queued input"));
    await expect(migrateDesktopDataDirectory(deps)).rejects.toThrow("queued input");
    expect(mocks.abort).toHaveBeenCalledWith("/home", "migration-1");
    expect(deps.cancelReservation).toHaveBeenCalledWith("migration-1");
    expect(deps.prepareProcesses).not.toHaveBeenCalled();
    expect(deps.restartAfterFailure).not.toHaveBeenCalled();
    expect(deps.restart).not.toHaveBeenCalled();
    expect(mocks.ready).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("still unseals owners when recording cancellation fails", async () => {
    const deps = options();
    deps.reserveProcesses.mockRejectedValue(new Error("DATA_DIRECTORY_BUSY"));
    mocks.abort.mockRejectedValue(new Error("disk unavailable"));
    await expect(migrateDesktopDataDirectory(deps)).rejects.toThrow("DATA_DIRECTORY_CANCEL_FAILED");
    expect(deps.cancelReservation).toHaveBeenCalledWith("migration-1");
    expect(deps.prepareProcesses).not.toHaveBeenCalled();
    expect(deps.restartAfterFailure).not.toHaveBeenCalled();
  });

  it("aborts and restarts the old root after a rejected close without recording ready", async () => {
    const deps = options();
    deps.prepareProcesses.mockRejectedValue(new Error("busy"));
    await expect(migrateDesktopDataDirectory(deps)).rejects.toThrow("busy");
    expect(mocks.abort).toHaveBeenCalledWith("/home", "migration-1");
    expect(deps.restartAfterFailure).toHaveBeenCalledOnce();
    expect(mocks.ready).not.toHaveBeenCalled();
    expect(deps.restart).not.toHaveBeenCalled();
  });

  it("still cold restarts after close failure when the cancellation journal cannot be saved", async () => {
    const deps = options();
    deps.prepareProcesses.mockRejectedValue(new Error("strict close failed"));
    mocks.abort.mockRejectedValue(new Error("disk unavailable"));
    await expect(migrateDesktopDataDirectory(deps)).rejects.toThrow("DATA_DIRECTORY_CANCEL_FAILED");
    expect(deps.restartAfterFailure).toHaveBeenCalledOnce();
    expect(deps.cancelReservation).not.toHaveBeenCalled();
    expect(mocks.ready).not.toHaveBeenCalled();
  });

  it("refuses ready if an independent process still holds a lease", async () => {
    mocks.leases.mockResolvedValue([{ pid: process.pid }, { pid: process.pid + 1 }]);
    await expect(migrateDesktopDataDirectory(options())).rejects.toThrow("ZCODE_DATA_IN_USE");
    expect(mocks.ready).not.toHaveBeenCalled();
  });

  it("preserves root session layout and excludes a superseded internal session before importing external sessionData", async () => {
    const deps = options();
    deps.sessionDataDir = "/external/session";
    await migrateDesktopDataDirectory(deps);
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        electronProfileLayouts: { stable: "session" },
        sources: [
          {
            sourcePath: "/profile",
            targetRelativePath: join("desktop", "stable"),
            exclude: ["session"],
          },
          {
            sourcePath: "/external/session",
            targetRelativePath: join("desktop", "stable", "session"),
          },
        ],
      }),
    );
  });
});
