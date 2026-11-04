import { join, normalize } from "node:path";
import type { RuntimeConfigPatch } from "@zcode/contracts";
import { getUnifiedDataRoot } from "@zcode/shared/data-directory";
import { resolvePath } from "./file-config.adapter.js";

/** 统一根生效后禁止配置重新拆分写入位置；旧配置由迁移器在副本中转换。 */
export function assertUnifiedStorageConfig(config: RuntimeConfigPatch): void {
  const root = getUnifiedDataRoot();
  if (!root) return;
  const comparable = (value: string): string => {
    const path = normalize(resolvePath(value));
    return process.platform === "win32" ? path.toLowerCase() : path;
  };
  const storage = config.storage;
  if (
    (storage?.dir && comparable(storage.dir) !== comparable(root)) ||
    (storage?.sessionDbPath &&
      comparable(storage.sessionDbPath) !== comparable(join(root, "cli", "db", "db.sqlite")))
  ) {
    throw Object.assign(
      new Error(
        "Storage configuration conflicts with the unified data directory. Remove the explicit override before starting ZCode.",
      ),
      { code: "ZCODE_DATA_STORAGE_CONFLICT" },
    );
  }
}
