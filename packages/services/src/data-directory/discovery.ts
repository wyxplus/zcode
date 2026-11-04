import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  readDataDirectoryLocator,
  validateDataDirectoryLocator,
} from "@zcode/shared/data-directory";
import { absolutePath } from "./io.js";
import { migrationError, type DataDirectorySource } from "./types.js";

interface DiscoveryOptions {
  homeDir: string;
  appBaseDir: string;
  cliStorageRoot?: string;
  sessionDbPath?: string;
  electronProfiles?: Array<{ sourcePath: string; variant: string }>;
  seaAssetCacheDir?: string;
}

const CLI_GLOBAL_NAMESPACES = new Set(["agents", "agent-memory", "security"]);

const APP_NAMESPACES = new Set([
  "v2",
  "workspace",
  "export-log",
  "export-log-stage",
  "feedback",
  "git-checkpoint-index",
  "clipboard",
  "tmp",
  "editor-icon",
]);

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 首次迁移按实际 owner 拆出来源；后续迁移只接受已登记的单一数据根。 */
export async function discoverLegacyDataDirectorySources(
  options: DiscoveryOptions,
): Promise<DataDirectorySource[]> {
  const locator = await readDataDirectoryLocator(options.homeDir);
  if (locator) {
    await validateDataDirectoryLocator(locator);
    const excludes = [".data-root.json"];
    for (const variant of ["stable", "preview", "development"]) {
      for (const directory of [join("desktop", variant), join("desktop", variant, "session")]) {
        for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"])
          excludes.push(join(directory, name));
      }
    }
    return [{ sourcePath: locator.root, targetRelativePath: "", exclude: excludes }];
  }
  const homeRoot = join(resolve(options.homeDir), ".zcode");
  const appRoot = join(resolve(options.appBaseDir), ".zcode");
  const configPath = join(homeRoot, "cli", "config.json");
  let config: { storage?: { dir?: string; sessionDbPath?: string } } = {};
  if (await exists(configPath)) {
    try {
      config = JSON.parse(await readFile(configPath, "utf8"));
      if (
        !config ||
        typeof config !== "object" ||
        Array.isArray(config) ||
        (config.storage !== undefined &&
          (!config.storage || typeof config.storage !== "object" || Array.isArray(config.storage)))
      )
        throw new Error("Invalid storage configuration");
    } catch {
      migrationError("INVALID_CONFIG", "无法解析当前 CLI 配置，不能推断数据来源");
    }
  }
  function configuredPath(value: unknown, fallback: string): string {
    if (value === undefined || value === "") return fallback;
    if (typeof value !== "string" || !value.trim())
      migrationError("INVALID_CONFIG", "存储目录配置必须是非空路径");
    const path = value.trim();
    // 历史相对路径随每个 Agent 的 cwd 变化；Main 无法唯一确定来源，不能按自身 cwd 猜一份。
    if (!isAbsolute(path) && !path.startsWith("~/") && !path.startsWith("~\\")) {
      migrationError(
        "AMBIGUOUS_SOURCE",
        "相对存储路径无法确定唯一来源，请先改为实际使用的绝对路径",
      );
    }
    return absolutePath(path, options.homeDir);
  }
  const storageRoot = configuredPath(
    options.cliStorageRoot?.trim() || config.storage?.dir,
    homeRoot,
  );
  const cliRoot = basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
  const databasePath = configuredPath(
    options.sessionDbPath?.trim() || config.storage?.sessionDbPath,
    join(homeRoot, "cli", "db", "db.sqlite"),
  );
  const sources: DataDirectorySource[] = [];
  const add = async (sourcePath: string, targetRelativePath: string, exclude?: string[]) => {
    if (await exists(sourcePath))
      sources.push({ sourcePath, targetRelativePath, ...(exclude ? { exclude } : {}) });
  };
  // 各 namespace 只有一个实际 owner。HOME 的未知内容保留，已知 App/CLI 目录单独选源，
  // 避免自定义 CLI 根不存在时连同仍在 HOME 的有效 config 一起漏掉。
  await add(homeRoot, "", [".data-root.json", "cli", ...APP_NAMESPACES, ...CLI_GLOBAL_NAMESPACES]);
  for (const name of APP_NAMESPACES) {
    await add(
      join(appRoot, name),
      name,
      name === "v2" ? ["setting.json", "setting.json.lock", "agents-state.json"] : undefined,
    );
  }
  // 旧版只复制 v2，已有会话可能仍引用 HOME workspace；两根文件都须归拢，冲突明确停止。
  if (appRoot !== homeRoot) await add(join(homeRoot, "workspace"), "workspace");
  await add(join(homeRoot, "v2", "setting.json"), join("v2", "setting.json"));
  await add(join(storageRoot, "v2", "agents-state.json"), join("v2", "agents-state.json"));
  for (const name of CLI_GLOBAL_NAMESPACES) await add(join(storageRoot, name), name);

  // root/cli 布局存在两套历史消费者；一旦内部又有 cli，无法证明该选哪份输出/插件目录。
  if (basename(storageRoot) === "cli" && (await exists(join(storageRoot, "cli")))) {
    migrationError("AMBIGUOUS_SOURCE", "CLI 根同时包含嵌套 cli 目录，无法安全归拢两套历史布局");
  }
  const cliExcludes = [
    "config.json",
    "config.json.lock",
    "db/db.sqlite",
    "db/db.sqlite-wal",
    "db/db.sqlite-shm",
    "db/db.sqlite-journal",
  ];
  // logging / workflow 等历史消费者仍固定写 HOME/cli。保留两个来源的不同文件；
  // 同名内容无法证明归属时由清单拒绝，不能因为改过 storage.dir 就丢掉 HOME 侧历史。
  if (cliRoot !== join(homeRoot, "cli")) await add(join(homeRoot, "cli"), "cli", cliExcludes);
  await add(cliRoot, "cli", [
    ...cliExcludes,
    ...(cliRoot === storageRoot ? [...CLI_GLOBAL_NAMESPACES, "v2"] : []),
  ]);
  // 用户配置和默认 session DB 不跟随旧 storage.dir；必须独立盘点其真实来源。
  await add(configPath, join("cli", "config.json"));
  await add(databasePath, join("cli", "db", "db.sqlite"));

  // 非 HOME 根中的未知条目仍保留；不同来源的同名文件由清单阶段明确拒绝，绝不按时间覆盖。
  for (const root of new Set([appRoot, storageRoot])) {
    if (root === homeRoot || root === cliRoot || !(await exists(root))) continue;
    for (const name of await readdir(root)) {
      if (
        name === ".data-root.json" ||
        name === "cli" ||
        APP_NAMESPACES.has(name) ||
        CLI_GLOBAL_NAMESPACES.has(name)
      )
        continue;
      await add(join(root, name), name);
    }
  }
  for (const profile of options.electronProfiles ?? []) {
    if (!/^[a-z][a-z0-9-]*$/u.test(profile.variant))
      migrationError("INVALID_PLAN", "无效的桌面 profile 名称");
    if (await exists(profile.sourcePath))
      sources.push({
        sourcePath: profile.sourcePath,
        targetRelativePath: join("desktop", profile.variant),
        exclude: ["SingletonLock", "SingletonCookie", "SingletonSocket"].flatMap((name) => [
          name,
          join("session", name),
        ]),
      });
  }
  const seaAssets =
    options.seaAssetCacheDir ??
    (process.platform === "darwin"
      ? join(options.homeDir, "Library", "Caches", "zcode", "sea-assets")
      : process.platform === "win32"
        ? join(
            process.env.LOCALAPPDATA || join(options.homeDir, "AppData", "Local"),
            "zcode",
            "Cache",
            "sea-assets",
          )
        : join(
            process.env.XDG_CACHE_HOME || join(options.homeDir, ".cache"),
            "zcode",
            "sea-assets",
          ));
  if (await exists(seaAssets))
    sources.push({ sourcePath: seaAssets, targetRelativePath: join("cache", "sea-assets") });
  // 保留原来的路径字符串用于迁移绝对引用；realpath 在此只验证来源可以访问。
  await Promise.all(sources.map((source) => realpath(source.sourcePath)));
  return sources;
}
