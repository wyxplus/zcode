import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const absolutePath = z.string().min(1).refine(isAbsolute, "Expected an absolute path");
export const dataDirectoryLocatorSchema = z
  .object({
    version: z.literal(1),
    root: absolutePath,
    generation: z.string().min(1),
    committedAt: z.number().finite().nonnegative(),
  })
  .strict();
export type DataDirectoryLocator = z.infer<typeof dataDirectoryLocatorSchema>;

export const dataDirectoryMaintenanceSchema = z
  .object({
    version: z.literal(1),
    migrationId: z.string().min(1),
    createdAt: z.number().finite().nonnegative(),
  })
  .strict();

export const dataDirectoryLeaseSchema = z
  .object({
    id: z.string().uuid(),
    pid: z.number().int().positive(),
    role: z.string().min(1),
    generation: z.string().nullable(),
  })
  .strict();
export type DataDirectoryUsageRecord = z.infer<typeof dataDirectoryLeaseSchema>;
export interface DataDirectoryUsageLease extends DataDirectoryUsageRecord {
  release(): Promise<void>;
}

export interface DataDirectoryOptions {
  homeDir?: string;
}
export interface DataDirectoryMaintenanceOptions extends DataDirectoryOptions {
  migrationId: string;
}
export const DATA_DIRECTORY_ROOT_MARKER = ".data-root.json";
export const dataDirectoryRootMarkerSchema = z
  .object({
    version: z.literal(1),
    generation: z.string().min(1),
  })
  .strict();

export function resolveDataDirectoryHome(homeDir?: string): string {
  return resolve(
    homeDir?.trim() ||
      process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
      process.env.HOME?.trim() ||
      process.env.USERPROFILE?.trim() ||
      homedir(),
  );
}

export function getDataDirectoryControlPaths(homeDir?: string) {
  const resolvedHome = resolveDataDirectoryHome(homeDir);
  const directory = join(resolvedHome, ".zcode-data-directory");
  return {
    homeDir: resolvedHome,
    directory,
    locator: join(directory, "active.json"),
    maintenance: join(directory, "maintenance.json"),
    leases: join(directory, "leases"),
    journal: join(directory, "transaction.json"),
    gate: join(directory, "gate"),
  };
}

export function dataDirectoryError(
  code: string,
  message: string,
  cause?: unknown,
): Error & { code: string } {
  return Object.assign(new Error(message, { cause }), { code });
}
export function dataDirectoryFsCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
