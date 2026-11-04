import { stat } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { readDataDirectoryJson, writeDataDirectoryJson } from "./dataDirectoryPersistence.js";
import {
  DATA_DIRECTORY_ROOT_MARKER,
  dataDirectoryError,
  dataDirectoryLocatorSchema,
  dataDirectoryRootMarkerSchema,
  getDataDirectoryControlPaths,
  resolveDataDirectoryHome,
  type DataDirectoryLocator,
} from "./dataDirectoryTypes.js";
const activeRoots = new Map<string, DataDirectoryLocator | null>();

export function getUnifiedDataRoot(homeDir?: string): string | null {
  return activeRoots.get(resolveDataDirectoryHome(homeDir))?.root ?? null;
}
export function resolveManagedDataRoot(homeDir?: string): string {
  return getUnifiedDataRoot(homeDir) ?? join(resolveDataDirectoryHome(homeDir), ".zcode");
}

export function assertUnifiedDataDirectoryEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): void {
  const root = getUnifiedDataRoot(homeDir);
  if (!root) return;
  const normalizePath = (value: string) => {
    const expanded = value.startsWith("~/")
      ? join(resolveDataDirectoryHome(homeDir), value.slice(2))
      : value;
    const result = normalize(resolve(expanded));
    return process.platform === "win32" ? result.toLowerCase() : result;
  };
  const entries = [
    [env.ZCODE_STORAGE_DIR, root],
    [env.ZCODE_SESSION_DB_PATH ?? env.ZCODE_SESSION_DB, join(root, "cli", "db", "db.sqlite")],
    [env.ZCODE_DATA_BASE_DIR, dirname(root)],
  ] as const;
  if (
    entries.some(
      ([configured, expected]) =>
        configured?.trim() && normalizePath(configured.trim()) !== normalizePath(expected),
    )
  ) {
    throw dataDirectoryError(
      "ZCODE_DATA_STORAGE_CONFLICT",
      "An explicit storage environment override conflicts with the unified data directory",
    );
  }
}

export async function readDataDirectoryLocator(
  homeDir?: string,
): Promise<DataDirectoryLocator | null> {
  try {
    const raw = await readDataDirectoryJson(getDataDirectoryControlPaths(homeDir).locator);
    return raw === undefined ? null : dataDirectoryLocatorSchema.parse(raw);
  } catch (cause) {
    throw dataDirectoryError(
      "ZCODE_DATA_LOCATOR_INVALID",
      "The data directory locator cannot be read. Restore it before starting ZCode.",
      cause,
    );
  }
}

export async function validateDataDirectoryLocator(locator: DataDirectoryLocator): Promise<void> {
  try {
    if (!(await stat(locator.root)).isDirectory()) throw new Error("Data root is not a directory");
    const marker = dataDirectoryRootMarkerSchema.parse(
      await readDataDirectoryJson(join(locator.root, DATA_DIRECTORY_ROOT_MARKER)),
    );
    if (marker.generation !== locator.generation)
      throw new Error("Data root generation does not match the locator");
  } catch (cause) {
    throw dataDirectoryError(
      "ZCODE_DATA_ROOT_UNAVAILABLE",
      "The configured data directory is unavailable or incomplete. ZCode will not create an empty replacement.",
      cause,
    );
  }
}

export async function writeDataDirectoryRootMarker(
  root: string,
  generation: string,
): Promise<void> {
  if (!(await stat(root)).isDirectory())
    throw new Error("Data root must exist before marking it complete");
  await writeDataDirectoryJson(
    join(root, DATA_DIRECTORY_ROOT_MARKER),
    dataDirectoryRootMarkerSchema.parse({ version: 1, generation }),
  );
}

export function setActiveDataDirectory(
  homeDir: string,
  locator: DataDirectoryLocator | null,
): void {
  activeRoots.set(resolveDataDirectoryHome(homeDir), locator);
}
