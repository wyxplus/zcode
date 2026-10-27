import { afterEach, describe, expect, it, vi } from "vitest";

const { init } = vi.hoisted(() => ({ init: vi.fn() }));

vi.mock("@arms/rum-electron/browser", () => ({
  default: { init },
}));

describe("ARMS Browser init", () => {
  afterEach(() => {
    init.mockReset();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("即使端点和桥接存在也不初始化云 SDK", async () => {
    vi.stubGlobal("__ZCODE_ENV__", "production");
    vi.stubGlobal("ArmsEventBridge", { send: vi.fn() });
    const { initArmsBrowserRumOnce } = await import("../src/shared/armsBrowserInit.js");

    expect(initArmsBrowserRumOnce("development")).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });
});
