import { resolve } from "node:path";
import { withFileLock } from "./privateFilePersistence.js";
import { writeDataDirectoryJson } from "./dataDirectoryPersistence.js";
import {
  dataDirectoryError,
  dataDirectoryLocatorSchema,
  getDataDirectoryControlPaths,
  resolveDataDirectoryHome,
  type DataDirectoryLocator,
  type DataDirectoryMaintenanceOptions,
  type DataDirectoryOptions,
} from "./dataDirectoryTypes.js";
import {
  assertDataDirectoryUnused,
  assertMaintenanceOwner,
  assertNoDataDirectoryMaintenance,
} from "./dataDirectoryLeases.js";
import {
  readDataDirectoryLocator,
  setActiveDataDirectory,
  validateDataDirectoryLocator,
} from "./dataDirectoryRoot.js";
export {
  getUnifiedDataRoot,
  resolveManagedDataRoot,
  readDataDirectoryLocator,
  validateDataDirectoryLocator,
  writeDataDirectoryRootMarker,
} from "./dataDirectoryRoot.js";
export async function initializeDataDirectory(
  options: DataDirectoryOptions = {},
): Promise<DataDirectoryLocator | null> {
  const home = resolveDataDirectoryHome(options.homeDir);
  await assertNoDataDirectoryMaintenance(home);
  const locator = await readDataDirectoryLocator(home);
  if (locator) await validateDataDirectoryLocator(locator);
  setActiveDataDirectory(home, locator);
  return locator;
}

export async function commitDataDirectoryLocator(
  locator: DataDirectoryLocator,
  options: DataDirectoryMaintenanceOptions & { expectedGeneration: string | null },
): Promise<void> {
  const paths = getDataDirectoryControlPaths(options.homeDir);
  const validated = dataDirectoryLocatorSchema.parse(locator);
  if (resolve(validated.root) !== validated.root) throw new Error("Data root must be normalized");
  await withFileLock(paths.gate, async () => {
    await assertMaintenanceOwner(options);
    await assertDataDirectoryUnused(paths.homeDir);
    const current = await readDataDirectoryLocator(paths.homeDir);
    await validateDataDirectoryLocator(validated);
    // 重试同一提交幂等；旧事务不能覆盖后续迁移的启动指针。
    if (current?.generation === validated.generation && current.root === validated.root) return;
    if ((current?.generation ?? null) !== options.expectedGeneration) {
      throw dataDirectoryError(
        "ZCODE_DATA_MIGRATION_CONFLICT",
        "The active data directory changed during migration",
      );
    }
    await writeDataDirectoryJson(paths.locator, validated);
  });
}
