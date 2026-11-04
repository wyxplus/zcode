import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginDataDirectoryMaintenance,
  commitDataDirectoryLocator,
  endDataDirectoryMaintenance,
  initializeDataDirectory,
  writeDataDirectoryRootMarker,
} from "@zcode/shared/data-directory";
import { createConfig } from "../src/config/config-factory.js";
import { getDefaultConfigPath } from "../src/config/file-config.adapter.js";
import { getDefaultLogDir } from "../src/logging/index.js";
import { getDefaultSessionDbPath } from "../src/storage/session-store/paths.js";
import { resolveDefaultSkillRoots } from "../src/skills/roots.js";
import { resolveSharedZCodeCredentialsPath } from "../src/auth/shared-credentials.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function migratedFixture() {
  const home = await mkdtemp(join(tmpdir(), "unified-cli-root-"));
  directories.push(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("ZCODE_DESKTOP_HOME_DIR", "");
  const root = join(home, "destination", ".zcode");
  await mkdir(join(root, "cli"), { recursive: true });
  const migration = { homeDir: home, migrationId: "migration" };
  await beginDataDirectoryMaintenance(migration);
  await writeDataDirectoryRootMarker(root, "generation");
  await commitDataDirectoryLocator(
    { version: 1, root, generation: "generation", committedAt: 1 },
    { ...migration, expectedGeneration: null },
  );
  await endDataDirectoryMaintenance(migration);
  await initializeDataDirectory({ homeDir: home });
  return { home, root };
}

describe("CLI unified storage consumers", () => {
  it("uses one verified root for config, database, logs, credentials and user skills", async () => {
    const { root, home } = await migratedFixture();
    await writeFile(join(root, "cli", "config.json"), JSON.stringify({ ui: { theme: "dark" } }));
    const result = createConfig({ env: {} });
    expect(result.sources.user.path).toBe(join(root, "cli", "config.json"));
    expect(result.sources.user.loaded).toBe(true);
    expect(result.config.storage).toEqual({
      dir: root,
      sessionDbPath: join(root, "cli", "db", "db.sqlite"),
    });
    expect(getDefaultConfigPath()).toBe(join(root, "cli", "config.json"));
    expect(getDefaultSessionDbPath()).toBe(join(root, "cli", "db", "db.sqlite"));
    expect(getDefaultLogDir()).toBe(join(root, "cli", "log"));
    expect(resolveSharedZCodeCredentialsPath()).toBe(join(root, "v2", "credentials.json"));
    const skills = await resolveDefaultSkillRoots(home, { homeDirectory: home });
    expect(skills.find((entry) => entry.scope === "user" && entry.source === "zcode")?.path).toBe(
      join(root, "skills"),
    );
    expect(skills.find((entry) => entry.scope === "user" && entry.source === "agents")?.path).toBe(
      join(home, ".agents", "skills"),
    );
    expect(process.env.HOME).toBe(home);
  });

  it("rejects explicit roots and database overrides that would split migrated data", async () => {
    const { root } = await migratedFixture();
    expect(() => createConfig({ env: { ZCODE_STORAGE_DIR: join(root, "other") } })).toThrow(
      "conflicts",
    );
    expect(() =>
      createConfig({ env: { ZCODE_SESSION_DB_PATH: join(root, "other.sqlite") } }),
    ).toThrow("conflicts");
    expect(() =>
      createConfig({
        env: {
          ZCODE_STORAGE_DIR: root,
          ZCODE_SESSION_DB_PATH: join(root, "cli", "db", "db.sqlite"),
        },
      }),
    ).not.toThrow();
  });
});
