import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDataDirectoryControlPaths,
  writeDataDirectoryRootMarker,
} from "@zcode/shared/data-directory";
import { discoverLegacyDataDirectorySources } from "../src/data-directory/discovery.js";
import { inventoryMigrationSources } from "../src/data-directory/inventory.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function file(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), "zcode-data-discovery-"));
  temporaryDirectories.push(homeDir);
  const homeRoot = join(homeDir, ".zcode");
  const storageRoot = join(homeDir, "custom-storage");
  await file(join(homeRoot, "v2", "setting.json"), '{"locale":"zh-CN"}');
  await file(
    join(homeRoot, "cli", "config.json"),
    JSON.stringify({ storage: { dir: storageRoot }, customPreference: "keep" }),
  );
  return { homeDir, homeRoot, storageRoot, appBaseDir: homeDir };
}

async function discoveredFiles(options: Parameters<typeof discoverLegacyDataDirectorySources>[0]) {
  const inventory = await inventoryMigrationSources(
    await discoverLegacyDataDirectorySources(options),
  );
  return new Map(
    await Promise.all(
      inventory
        .filter((entry) => entry.kind === "file")
        .map(
          async (entry) =>
            [
              entry.relativePath.replaceAll("\\", "/"),
              await readFile(entry.source, "utf8"),
            ] as const,
        ),
    ),
  );
}

describe("migration source ownership", () => {
  it("retains authoritative HOME config even if a custom CLI data root does not exist", async () => {
    const f = await fixture();
    const files = await discoveredFiles(f);
    expect(JSON.parse(files.get("cli/config.json")!)).toMatchObject({ customPreference: "keep" });
    expect(files.get("v2/setting.json")).toContain("zh-CN");
  });

  it("retains bootstrap settings when the historical custom App root is absent", async () => {
    const f = await fixture();
    const files = await discoveredFiles({ ...f, appBaseDir: join(f.homeDir, "missing-app") });
    expect(files.get("v2/setting.json")).toContain("zh-CN");
    expect(files.has("cli/config.json")).toBe(true);
  });

  it("combines default workspace files left by the old v2-only migration and refuses collisions", async () => {
    const f = await fixture();
    const appBaseDir = join(f.homeDir, "custom-app");
    await file(join(f.homeRoot, "workspace", "default", "old.txt"), "old user file");
    await file(join(appBaseDir, ".zcode", "workspace", "default", "new.txt"), "new user file");
    const files = await discoveredFiles({ ...f, appBaseDir });
    expect(files.get("workspace/default/old.txt")).toBe("old user file");
    expect(files.get("workspace/default/new.txt")).toBe("new user file");
    await file(
      join(appBaseDir, ".zcode", "workspace", "default", "old.txt"),
      "conflicting user file",
    );
    await expect(discoveredFiles({ ...f, appBaseDir })).rejects.toMatchObject({
      code: "DATA_DIRECTORY_SOURCE_CONFLICT",
    });
    expect(await readFile(join(f.homeRoot, "workspace", "default", "old.txt"), "utf8")).toBe(
      "old user file",
    );
  });

  it("uses the HOME CLI config instead of a stale config copied into storage.dir", async () => {
    const f = await fixture();
    await file(join(f.storageRoot, "cli", "config.json"), '{"customPreference":"stale"}');
    await file(join(f.storageRoot, "cli", "plugins", "installed_plugins.json"), '{"plugins":[]}');
    const files = await discoveredFiles(f);
    expect(JSON.parse(files.get("cli/config.json")!).customPreference).toBe("keep");
    expect(files.has("cli/plugins/installed_plugins.json")).toBe(true);
  });

  it("preserves custom-root globals and HOME CLI logs/workflows/unknown historical files", async () => {
    const f = await fixture();
    await file(join(f.homeRoot, "agents", "old.md"), "inactive agent");
    await file(join(f.storageRoot, "agents", "current.md"), "active agent");
    await file(join(f.storageRoot, "agent-memory", "one", "memory.md"), "memory");
    await file(join(f.storageRoot, "security", "workspace-hook-trust-v1.json"), "{}");
    await file(join(f.storageRoot, "v2", "agents-state.json"), '{"disabledAgentIds":["one"]}');
    await file(join(f.storageRoot, "unknown-custom.bin"), "custom bytes");
    await file(join(f.homeRoot, "cli", "log", "old.jsonl"), "log");
    await file(join(f.homeRoot, "cli", "workflows", "saved.dwf.ts"), "workflow");
    await file(join(f.homeRoot, "cli", "unknown-history.bin"), "history");
    const files = await discoveredFiles(f);
    expect(files.get("agents/current.md")).toBe("active agent");
    expect(files.has("agents/old.md")).toBe(false);
    expect(files.get("agent-memory/one/memory.md")).toBe("memory");
    expect(files.get("security/workspace-hook-trust-v1.json")).toBe("{}");
    expect(files.get("v2/agents-state.json")).toContain("one");
    expect(files.get("unknown-custom.bin")).toBe("custom bytes");
    expect(files.get("cli/log/old.jsonl")).toBe("log");
    expect(files.get("cli/workflows/saved.dwf.ts")).toBe("workflow");
    expect(files.get("cli/unknown-history.bin")).toBe("history");
  });

  it("fails closed for cwd-relative overrides instead of selecting Main's working directory", async () => {
    const f = await fixture();
    await expect(
      discoverLegacyDataDirectorySources({ ...f, cliStorageRoot: "relative-storage" }),
    ).rejects.toMatchObject({ code: "DATA_DIRECTORY_AMBIGUOUS_SOURCE" });
    await expect(
      discoverLegacyDataDirectorySources({ ...f, sessionDbPath: "relative.sqlite" }),
    ).rejects.toMatchObject({ code: "DATA_DIRECTORY_AMBIGUOUS_SOURCE" });
  });

  it("refuses a mixed historical cli/cli layout instead of leaving outputs in the wrong namespace", async () => {
    const f = await fixture();
    const storageRoot = join(f.homeDir, "legacy", "cli");
    await file(join(storageRoot, "cli", "artifacts", "result.txt"), "output");
    await expect(
      discoverLegacyDataDirectorySources({ ...f, cliStorageRoot: storageRoot }),
    ).rejects.toMatchObject({ code: "DATA_DIRECTORY_AMBIGUOUS_SOURCE" });
  });

  it("excludes only known Chromium singleton files during subsequent whole-root moves", async () => {
    const f = await fixture();
    const activeRoot = join(f.homeDir, "active", ".zcode");
    await file(join(activeRoot, "desktop", "development", "SingletonLock"), "stale process");
    await file(
      join(activeRoot, "desktop", "preview", "session", "SingletonSocket"),
      "stale socket",
    );
    await file(join(activeRoot, "desktop", "stable", "Preferences"), "profile");
    await file(join(activeRoot, "workspace", "SingletonLock"), "user file");
    await writeDataDirectoryRootMarker(activeRoot, "active-one");
    await file(
      getDataDirectoryControlPaths(f.homeDir).locator,
      JSON.stringify({ version: 1, root: activeRoot, generation: "active-one", committedAt: 1 }),
    );
    const files = await discoveredFiles(f);
    expect(files.has("desktop/development/SingletonLock")).toBe(false);
    expect(files.has("desktop/preview/session/SingletonSocket")).toBe(false);
    expect(files.get("desktop/stable/Preferences")).toBe("profile");
    expect(files.get("workspace/SingletonLock")).toBe("user file");
    expect(files.has("cli/config.json")).toBe(false);
  });
});
