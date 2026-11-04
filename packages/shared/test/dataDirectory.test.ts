import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDataDirectoryUsageLease,
  assertDataDirectoryUnused,
  assertUnifiedDataDirectoryEnvironment,
  beginDataDirectoryMaintenance,
  commitDataDirectoryLocator,
  endDataDirectoryMaintenance,
  getDataDirectoryControlPaths,
  getUnifiedDataRoot,
  initializeDataDirectory,
  readDataDirectoryLocator,
  resolveManagedDataRoot,
  writeDataDirectoryRootMarker,
} from "../src/data-directory.js";

const homes: string[] = [];
async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), "zcode-data-root-"));
  homes.push(homeDir);
  const root = join(homeDir, "target", ".zcode");
  await mkdir(root, { recursive: true });
  return { homeDir, root, generation: "generation-one", migrationId: "migration-one" };
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("unified data root", () => {
  it("preserves legacy paths until a verified locator is committed", async () => {
    const f = await fixture();
    expect(await initializeDataDirectory(f)).toBeNull();
    expect(resolveManagedDataRoot(f.homeDir)).toBe(join(f.homeDir, ".zcode"));
    await beginDataDirectoryMaintenance(f);
    await writeDataDirectoryRootMarker(f.root, f.generation);
    await commitDataDirectoryLocator(
      { version: 1, root: f.root, generation: f.generation, committedAt: Date.now() },
      { ...f, expectedGeneration: null },
    );
    await expect(initializeDataDirectory(f)).rejects.toMatchObject({
      code: "ZCODE_DATA_MAINTENANCE",
    });
    await endDataDirectoryMaintenance(f);
    await initializeDataDirectory(f);
    expect(getUnifiedDataRoot(f.homeDir)).toBe(f.root);
    expect(() =>
      assertUnifiedDataDirectoryEnvironment({ ZCODE_STORAGE_DIR: f.root }, f.homeDir),
    ).not.toThrow();
    expect(() =>
      assertUnifiedDataDirectoryEnvironment(
        { ZCODE_STORAGE_DIR: join(f.root, "other") },
        f.homeDir,
      ),
    ).toThrow("conflicts");
    const other = await fixture();
    expect(getUnifiedDataRoot(other.homeDir)).toBeNull();
  });

  it("fails closed for missing or corrupt active roots instead of creating a default root", async () => {
    const f = await fixture();
    const paths = getDataDirectoryControlPaths(f.homeDir);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(
      paths.locator,
      JSON.stringify({ version: 1, root: f.root, generation: f.generation, committedAt: 1 }),
    );
    await expect(initializeDataDirectory(f)).rejects.toMatchObject({
      code: "ZCODE_DATA_ROOT_UNAVAILABLE",
    });
    await writeDataDirectoryRootMarker(f.root, "wrong-generation");
    await expect(initializeDataDirectory(f)).rejects.toMatchObject({
      code: "ZCODE_DATA_ROOT_UNAVAILABLE",
    });
    await writeFile(paths.locator, "{");
    await expect(readDataDirectoryLocator(f.homeDir)).rejects.toMatchObject({
      code: "ZCODE_DATA_LOCATOR_INVALID",
    });
  });

  it("blocks new writers during maintenance and never confuses a live lease with an idle process", async () => {
    const f = await fixture();
    const lease = await acquireDataDirectoryUsageLease({ homeDir: f.homeDir, role: "test-cli" });
    await beginDataDirectoryMaintenance(f);
    await expect(
      acquireDataDirectoryUsageLease({ homeDir: f.homeDir, role: "another-cli" }),
    ).rejects.toMatchObject({ code: "ZCODE_DATA_MAINTENANCE" });
    await expect(assertDataDirectoryUnused(f.homeDir)).rejects.toMatchObject({
      code: "ZCODE_DATA_IN_USE",
    });
    await lease.release();
    await lease.release();
    await expect(assertDataDirectoryUnused(f.homeDir)).resolves.toBeUndefined();
    await expect(
      endDataDirectoryMaintenance({ ...f, migrationId: "another-migration" }),
    ).rejects.toMatchObject({ code: "ZCODE_DATA_MIGRATION_CONFLICT" });
    await endDataDirectoryMaintenance(f);
  });

  it("requires the expected generation and never commits over a live writer", async () => {
    const f = await fixture();
    const lease = await acquireDataDirectoryUsageLease({ homeDir: f.homeDir, role: "test" });
    await beginDataDirectoryMaintenance(f);
    await writeDataDirectoryRootMarker(f.root, f.generation);
    const locator = { version: 1 as const, root: f.root, generation: f.generation, committedAt: 1 };
    await expect(
      commitDataDirectoryLocator(locator, { ...f, expectedGeneration: null }),
    ).rejects.toMatchObject({ code: "ZCODE_DATA_IN_USE" });
    await lease.release();
    await expect(
      commitDataDirectoryLocator(locator, { ...f, expectedGeneration: "old" }),
    ).rejects.toMatchObject({ code: "ZCODE_DATA_MIGRATION_CONFLICT" });
    await commitDataDirectoryLocator(locator, { ...f, expectedGeneration: null });
    expect(
      JSON.parse(await readFile(getDataDirectoryControlPaths(f.homeDir).locator, "utf8")),
    ).toEqual(locator);
  });
});
