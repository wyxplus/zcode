import { describe, expect, it, vi } from "vitest";

describe("paths", () => {
  it("Windows 数据目录不能选择 ZCode 安装目录或其子目录", async () => {
    vi.resetModules();

    const { validateDataBaseDirTarget } = await import("../src/paths.js");
    const env = {
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      ZCODE_WINDOWS_APP_INSTALL_DIR: "C:\\Users\\tester\\AppData\\Local\\Programs\\ZCode",
    };

    expect(
      validateDataBaseDirTarget("c:\\program files\\zcode", {
        platform: "win32",
        env,
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateDataBaseDirTarget("C:\\Users\\tester\\AppData\\Local\\Programs\\ZCode\\data", {
        platform: "win32",
        env,
      }),
    ).toMatchObject({ ok: false });
  });

  it("Windows 数据目录保护不会误伤同名前缀的普通目录", async () => {
    vi.resetModules();

    const { validateDataBaseDirTarget } = await import("../src/paths.js");
    const env = {
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      ZCODE_WINDOWS_APP_INSTALL_DIR: "C:\\Users\\tester\\AppData\\Local\\Programs\\ZCode",
    };

    expect(
      validateDataBaseDirTarget("C:\\Users\\tester\\AppData\\Local\\Programs\\ZCodeData", {
        platform: "win32",
        env,
      }),
    ).toEqual({ ok: true });
    expect(
      validateDataBaseDirTarget("C:\\Users\\tester\\Documents\\ZCode", {
        platform: "win32",
        env,
      }),
    ).toEqual({ ok: true });
  });
});
