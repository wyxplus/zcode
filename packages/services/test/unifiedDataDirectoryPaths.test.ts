import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginDataDirectoryMaintenance,
  commitDataDirectoryLocator,
  endDataDirectoryMaintenance,
  initializeDataDirectory,
  writeDataDirectoryRootMarker,
} from "@zcode/shared/data-directory";
import {
  getAppConfigDir,
  getDataBaseDir,
  getProviderWorkspaceConfigDir,
  setDataBaseDir,
} from "../src/paths.js";
import { createSettingService } from "../src/setting/settingService.js";
import { resolveUserSubagentRoot } from "../src/subagents/subagentStorage.js";
import { createStorageRootsResolver } from "../src/storage/adapters/rootsResolver.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  setDataBaseDir(null);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("services unified data-root consumers", () => {
  it("uses the committed root for settings, provider, subagents and storage scans without changing HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-unified-consumers-"));
    dirs.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("ZCODE_DESKTOP_HOME_DIR", "");
    const target = join(home, "target");
    const root = join(target, ".zcode");
    await mkdir(join(root, "v2"), { recursive: true });
    await mkdir(join(root, "cli"), { recursive: true });
    await writeFile(join(root, "cli", "config.json"), "{}");
    await writeDataDirectoryRootMarker(root, "one");
    await beginDataDirectoryMaintenance({ homeDir: home, migrationId: "migration" });
    await commitDataDirectoryLocator(
      { version: 1, root, generation: "one", committedAt: Date.now() },
      {
        homeDir: home,
        migrationId: "migration",
        expectedGeneration: null,
      },
    );
    await endDataDirectoryMaintenance({ homeDir: home, migrationId: "migration" });
    await initializeDataDirectory({ homeDir: home });
    setDataBaseDir(join(home, "stale-app-root"));
    expect(getDataBaseDir()).toBe(target);
    expect(getAppConfigDir()).toBe(join(root, "v2"));
    expect(getProviderWorkspaceConfigDir()).toBe(join(root, "cli"));
    expect(await resolveUserSubagentRoot({ homeDir: home })).toBe(join(root, "agents"));
    await createSettingService().update({ locale: "zh-CN" });
    expect(JSON.parse(await readFile(join(root, "v2", "setting.json"), "utf8")).locale).toBe(
      "zh-CN",
    );
    await expect(readFile(join(home, ".zcode", "v2", "setting.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const roots = createStorageRootsResolver({
      getHomeDir: () => home,
      getDataBaseDir: () => target,
    });
    expect((await roots.resolveRoots()).map((entry) => entry.path)).toEqual([root]);
    expect(process.env.HOME).toBe(home);
  });

  it("rejects legacy RPC and settings patch bypasses before any copy or pointer update", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-migration-required-"));
    dirs.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("ZCODE_DESKTOP_HOME_DIR", "");
    const settings = createSettingService();
    await expect(settings.updateDataBaseDir(join(home, "new"))).rejects.toThrow(
      "MIGRATION_REQUIRED",
    );
    await expect(settings.update({ dataBaseDir: join(home, "new") })).rejects.toThrow(
      "MIGRATION_REQUIRED",
    );
    await expect(readFile(join(home, ".zcode", "v2", "setting.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
