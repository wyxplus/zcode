import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "./privateFilePersistence.js";
import { readDataDirectoryJson, writeDataDirectoryJson } from "./dataDirectoryPersistence.js";
import {
  dataDirectoryError,
  dataDirectoryFsCode,
  dataDirectoryLeaseSchema,
  dataDirectoryMaintenanceSchema,
  getDataDirectoryControlPaths,
  type DataDirectoryMaintenanceOptions,
  type DataDirectoryOptions,
  type DataDirectoryUsageLease,
  type DataDirectoryUsageRecord,
} from "./dataDirectoryTypes.js";
import {
  readDataDirectoryLocator,
  validateDataDirectoryLocator,
  setActiveDataDirectory,
} from "./dataDirectoryRoot.js";

async function readMaintenance(homeDir?: string) {
  const raw = await readDataDirectoryJson(getDataDirectoryControlPaths(homeDir).maintenance);
  return raw === undefined ? null : dataDirectoryMaintenanceSchema.parse(raw);
}
export async function assertNoDataDirectoryMaintenance(homeDir?: string): Promise<void> {
  if (await readMaintenance(homeDir)) {
    throw dataDirectoryError(
      "ZCODE_DATA_MAINTENANCE",
      "ZCode data migration is in progress. Wait for it to finish before starting another process.",
    );
  }
}
export async function assertMaintenanceOwner(
  options: DataDirectoryMaintenanceOptions,
): Promise<void> {
  if ((await readMaintenance(options.homeDir))?.migrationId !== options.migrationId) {
    throw dataDirectoryError(
      "ZCODE_DATA_MIGRATION_CONFLICT",
      "The data migration owner does not match",
    );
  }
}

export async function acquireDataDirectoryUsageLease(
  options: DataDirectoryOptions & { role: string },
): Promise<DataDirectoryUsageLease> {
  const paths = getDataDirectoryControlPaths(options.homeDir);
  return withFileLock(paths.gate, async () => {
    // 注册和维护闸门共用短锁，消除“检查空闲后又启动CLI”的窗口。
    await assertNoDataDirectoryMaintenance(paths.homeDir);
    const locator = await readDataDirectoryLocator(paths.homeDir);
    if (locator) await validateDataDirectoryLocator(locator);
    setActiveDataDirectory(paths.homeDir, locator);
    const record: DataDirectoryUsageRecord = {
      id: randomUUID(),
      pid: process.pid,
      role: options.role,
      generation: locator?.generation ?? null,
    };
    const path = join(paths.leases, `${record.id}.json`);
    await writeDataDirectoryJson(path, dataDirectoryLeaseSchema.parse(record));
    return {
      ...record,
      release: async () => {
        await rm(path, { force: true });
      },
    };
  });
}

export async function beginDataDirectoryMaintenance(
  options: DataDirectoryMaintenanceOptions,
): Promise<void> {
  const paths = getDataDirectoryControlPaths(options.homeDir);
  await withFileLock(paths.gate, async () => {
    const current = await readMaintenance(paths.homeDir);
    if (current) {
      await assertMaintenanceOwner(options);
      return;
    }
    await writeDataDirectoryJson(
      paths.maintenance,
      dataDirectoryMaintenanceSchema.parse({
        version: 1,
        migrationId: options.migrationId,
        createdAt: Date.now(),
      }),
    );
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return dataDirectoryFsCode(error) !== "ESRCH";
  }
}
export async function listLiveDataDirectoryLeases(
  homeDir?: string,
): Promise<DataDirectoryUsageRecord[]> {
  const paths = getDataDirectoryControlPaths(homeDir);
  let entries: string[];
  try {
    entries = await readdir(paths.leases);
  } catch (error) {
    if (dataDirectoryFsCode(error) === "ENOENT") return [];
    throw error;
  }
  const records: DataDirectoryUsageRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(paths.leases, entry);
    const raw = await readDataDirectoryJson(path);
    if (raw === undefined) continue;
    const record = dataDirectoryLeaseSchema.parse(raw);
    if (isAlive(record.pid)) records.push(record);
    else await rm(path, { force: true });
  }
  return records;
}

export async function assertDataDirectoryUnused(homeDir?: string): Promise<void> {
  if ((await listLiveDataDirectoryLeases(homeDir)).length > 0) {
    throw dataDirectoryError(
      "ZCODE_DATA_IN_USE",
      "Other ZCode processes are still using this data directory. Close them before migrating.",
    );
  }
}

export async function endDataDirectoryMaintenance(
  options: DataDirectoryMaintenanceOptions,
): Promise<void> {
  const paths = getDataDirectoryControlPaths(options.homeDir);
  await withFileLock(paths.gate, async () => {
    if (!(await readMaintenance(paths.homeDir))) return;
    await assertMaintenanceOwner(options);
    await rm(paths.maintenance);
  });
}
