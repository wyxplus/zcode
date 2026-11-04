import { describe, expect, it, vi } from "vitest";
import { CuaHelperLifecycleManager } from "@zcode/zcode-cua/broker/server";

describe("unavailable CUA helper lifecycle disposal", () => {
  it("disposes an unacquired helper repeatedly without invoking the resource callback", async () => {
    const stop = vi.fn(async (_managed: { helper: object }) => {});
    const lifecycle = new CuaHelperLifecycleManager(stop);
    const create = vi.fn(() => ({ helper: {} }));
    expect(await lifecycle.acquire({ isAdmitted: () => false, create })).toBeUndefined();
    await lifecycle.dispose();
    await lifecycle.dispose();
    expect(stop).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(lifecycle.peek()).toBeUndefined();
    expect(lifecycle.disposed).toBe(true);
  });

  it("propagates the acquired helper's stop failure to strict shutdown", async () => {
    const managed = { helper: {} };
    const failure = new Error("helper stop failed");
    const stop = vi.fn(async (_managed: typeof managed) => {
      throw failure;
    });
    const lifecycle = new CuaHelperLifecycleManager(stop);
    await lifecycle.acquire({ create: () => managed });
    await expect(lifecycle.dispose()).rejects.toBe(failure);
    expect(stop).toHaveBeenCalledExactlyOnceWith(managed);
    expect(lifecycle.disposed).toBe(true);
  });

  it("still disposes an explicitly supplied resource without acquiring it", async () => {
    const managed = { helper: {} };
    const stop = vi.fn(async (_managed: typeof managed) => {});
    const lifecycle = new CuaHelperLifecycleManager(stop);
    await lifecycle.dispose(managed);
    expect(stop).toHaveBeenCalledExactlyOnceWith(managed);
    expect(lifecycle.disposed).toBe(true);
  });
});
