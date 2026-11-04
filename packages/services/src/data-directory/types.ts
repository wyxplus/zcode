import type { DataDirectoryLocator } from "@zcode/shared/data-directory";

export interface DataDirectorySource {
  sourcePath: string;
  /** prepare 固定物理来源，引用改写同时接受历史别名与 canonical 路径。 */
  canonicalSourcePath?: string;
  targetRelativePath: string;
  exclude?: string[];
}

export interface DataDirectoryMigrationPlan {
  version: 1;
  id: string;
  phase: "prepared" | "ready" | "copying" | "verified" | "committed" | "cancelled";
  homeDir: string;
  targetBaseDir: string;
  targetRoot: string;
  stagingRoot: string;
  previousLocator: DataDirectoryLocator | null;
  sources: DataDirectorySource[];
  createdAt: number;
  preparingPid: number;
  sourceManifest?: MigrationFile[];
  targetManifest?: MigrationFile[];
  electronProfileLayouts?: Record<string, "root" | "session">;
  windowsAppInstallDir?: string;
  error?: string;
}

export interface MigrationPathMapping {
  source: string;
  target: string;
}

export interface MigrationFile {
  source: string;
  relativePath: string;
  kind: "directory" | "file" | "symlink" | "sqlite";
  size: number;
  hash?: string;
  walHash?: string;
  walSize?: number;
  linkTarget?: string;
  mode: number;
}

export class DataDirectoryMigrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "DataDirectoryMigrationError";
  }
}

export function migrationError(code: string, message: string): never {
  throw new DataDirectoryMigrationError(`DATA_DIRECTORY_${code}`, message);
}
