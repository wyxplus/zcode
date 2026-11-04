import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setPath: vi.fn(),
  whenReady: vi.fn(),
  relaunch: vi.fn(),
  quit: vi.fn(),
  exit: vi.fn(),
  showMessageBox: vi.fn(),
  showErrorBox: vi.fn(),
  abort: vi.fn(),
}));
vi.mock("electron", () => ({ app: mocks, dialog: mocks }));
vi.mock("node:fs/promises", () => ({ mkdtemp: vi.fn(async () => "/temporary/recovery") }));
vi.mock("@zcode/services/data-directory", () => ({ abortDataDirectoryMigration: mocks.abort }));
import { scheduleDataDirectoryRecovery } from "../src/main/desktopDataDirectoryRecovery.js";

describe("data directory maintenance recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("waits for ready with an isolated profile and cancels only after the user selects the original directory", async () => {
    let ready!: () => void;
    mocks.whenReady.mockReturnValue(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    );
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    mocks.abort.mockResolvedValue(undefined);
    await scheduleDataDirectoryRecovery("/home", "migration-1", new Error("disk full"));
    expect(mocks.setPath.mock.calls).toEqual([
      ["userData", "/temporary/recovery"],
      ["sessionData", "/temporary/recovery"],
    ]);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.abort).not.toHaveBeenCalled();
    ready();
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalled());
    expect(mocks.abort).toHaveBeenCalledWith("/home", "migration-1");
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });

  it("never restarts into the old directory if the transaction owner rejects cancellation after commit", async () => {
    mocks.whenReady.mockResolvedValue(undefined);
    mocks.showMessageBox
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 2 });
    mocks.abort.mockRejectedValue(new Error("DATA_DIRECTORY_ALREADY_COMMITTED"));
    await scheduleDataDirectoryRecovery("/home", "migration-1", new Error("commit interrupted"));
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalled());
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });
});
