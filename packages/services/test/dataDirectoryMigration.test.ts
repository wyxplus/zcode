import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireDataDirectoryUsageLease,
  beginDataDirectoryMaintenance,
  getDataDirectoryControlPaths,
  readDataDirectoryLocator,
} from "@zcode/shared/data-directory";
import { createCredentialCipherProvider } from "../src/credential/providers/credentialCipherProvider.js";
import { GitCheckpointStore } from "../src/git/repo/gitCheckpointStore.js";
import {
  abortDataDirectoryMigration,
  activateDataDirectoryMigrationMaintenance,
  assertPreparedDataDirectoryMigrationOwnerExited,
  discoverLegacyDataDirectorySources,
  executeDataDirectoryMigration,
  markDataDirectoryMigrationReady,
  prepareDataDirectoryMigration,
  readPendingDataDirectoryMigration,
} from "../src/data-directory/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), "zcode-data-migration-"));
  temporaryDirectories.push(homeDir);
  const root = join(homeDir, ".zcode");
  const targetBaseDir = join(homeDir, "destination");
  await mkdir(join(root, "v2"), { recursive: true });
  await mkdir(targetBaseDir);
  await writeFile(join(root, "v2", "setting.json"), JSON.stringify({ locale: "zh-CN" }));
  return { homeDir, root, targetBaseDir };
}

describe("统一数据目录迁移", () => {
  it("reserve 阶段允许已接受工作创建 lease，显式 activate 后才阻断新 owner", async () => {
    const f = await fixture();
    const plan = await prepareDataDirectoryMigration({
      ...f,
      sources: [{ sourcePath: f.root, targetRelativePath: "" }],
    });
    expect(plan.preparingPid).toBe(process.pid);
    const lease = await acquireDataDirectoryUsageLease({
      homeDir: f.homeDir,
      role: "accepted-child",
    });
    try {
      await activateDataDirectoryMigrationMaintenance(f.homeDir, plan.id);
      await activateDataDirectoryMigrationMaintenance(f.homeDir, plan.id);
      await expect(
        acquireDataDirectoryUsageLease({ homeDir: f.homeDir, role: "new-owner" }),
      ).rejects.toThrow();
    } finally {
      await lease.release();
      await abortDataDirectoryMigration(f.homeDir, plan.id);
    }
  });

  it("冷启动恢复不能取消仍存活 owner 的 prepared，原 owner 可以主动取消", async () => {
    const f = await fixture();
    const plan = await prepareDataDirectoryMigration({
      ...f,
      sources: [{ sourcePath: f.root, targetRelativePath: "" }],
    });
    await expect(
      assertPreparedDataDirectoryMigrationOwnerExited(f.homeDir, plan.id),
    ).rejects.toMatchObject({ code: "DATA_DIRECTORY_PREPARING_OWNER_ALIVE" });
    expect((await readPendingDataDirectoryMigration(f.homeDir))?.phase).toBe("prepared");
    await abortDataDirectoryMigration(f.homeDir, plan.id);
    expect(await readPendingDataDirectoryMigration(f.homeDir)).toBeNull();
  });

  it("prepared owner 已退出才允许冷启动恢复取消", async () => {
    const f = await fixture();
    const plan = await prepareDataDirectoryMigration({
      ...f,
      sources: [{ sourcePath: f.root, targetRelativePath: "" }],
    });
    const { stdout } = await promisify(execFile)(process.execPath, [
      "-e",
      "process.stdout.write(String(process.pid))",
    ]);
    await writeFile(
      getDataDirectoryControlPaths(f.homeDir).journal,
      JSON.stringify({ ...plan, preparingPid: Number(stdout) }),
    );
    await assertPreparedDataDirectoryMigrationOwnerExited(f.homeDir, plan.id);
    await abortDataDirectoryMigration(f.homeDir, plan.id);
    expect(await readPendingDataDirectoryMigration(f.homeDir)).toBeNull();
  });

  it("来源目录别名与 realpath 写入的引用同时迁移", async () => {
    const f = await fixture();
    const canonicalWorkspace = join(await realpath(f.root), "workspace", "default");
    await mkdir(canonicalWorkspace, { recursive: true });
    const alias = join(f.homeDir, "source-alias");
    await symlink(f.root, alias, process.platform === "win32" ? "junction" : "dir");
    await writeFile(
      join(f.root, "v2", "setting.json"),
      JSON.stringify({ recentProjects: [join(alias, "workspace", "default"), canonicalWorkspace] }),
    );
    const plan = await prepareDataDirectoryMigration({
      ...f,
      sources: [{ sourcePath: alias, targetRelativePath: "" }],
    });
    await markDataDirectoryMigrationReady(f.homeDir, plan.id);
    const locator = await executeDataDirectoryMigration(f.homeDir);
    const settings = JSON.parse(await readFile(join(locator.root, "v2", "setting.json"), "utf8"));
    expect(settings.recentProjects).toEqual([
      join(locator.root, "workspace", "default"),
      join(locator.root, "workspace", "default"),
    ]);
  });

  it("保留任意用户数据库与原始 JSON 产物，不把相似字段当作产品 schema", async () => {
    const f = await fixture();
    const workspace = join(f.root, "workspace", "default");
    await mkdir(workspace, { recursive: true });
    const userDb = new DatabaseSync(join(workspace, "user.sqlite"));
    userDb.exec(
      "CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,data TEXT)",
    );
    userDb.prepare("INSERT INTO session VALUES ('user-record',?)").run(workspace);
    userDb.prepare("INSERT INTO part VALUES ('user-part',?)").run("this is not JSON");
    userDb.close();
    const artifacts = join(f.root, "cli", "artifacts");
    await mkdir(artifacts, { recursive: true });
    const payloads = [
      "[1, 2, 3]\n",
      JSON.stringify({ directory: workspace, text: workspace }),
      "arbitrary non-JSON tool result",
    ];
    for (const [index, payload] of payloads.entries())
      await writeFile(join(artifacts, index + ".json"), payload);
    const plan = await prepareDataDirectoryMigration({
      ...f,
      sources: [{ sourcePath: f.root, targetRelativePath: "" }],
    });
    await markDataDirectoryMigrationReady(f.homeDir, plan.id);
    const locator = await executeDataDirectoryMigration(f.homeDir);
    const migrated = new DatabaseSync(join(locator.root, "workspace", "default", "user.sqlite"), {
      readOnly: true,
    });
    try {
      expect(migrated.prepare("SELECT directory FROM session").get()).toEqual({
        directory: workspace,
      });
      expect(migrated.prepare("SELECT data FROM part").get()).toEqual({ data: "this is not JSON" });
    } finally {
      migrated.close();
    }
    for (const [index, payload] of payloads.entries())
      expect(await readFile(join(locator.root, "cli", "artifacts", index + ".json"), "utf8")).toBe(
        payload,
      );
  });

  it("未知 SQLite、未 checkpoint 的 WAL 和损坏的插件数据库均逐字节保留", async () => {
    const f = await fixture();
    const workspace = join(f.root, "workspace", "default");
    const plugin = join(f.root, "cli", "plugins", "cache", "demo");
    await mkdir(workspace, { recursive: true });
    await mkdir(plugin, { recursive: true });
    const database = join(workspace, "user.sqlite");
    await promisify(execFile)(process.execPath, [
      "-e",
      "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec(\"PRAGMA foreign_keys=OFF; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE parent(id TEXT PRIMARY KEY); CREATE TABLE child(parent_id TEXT REFERENCES parent(id)); INSERT INTO child VALUES ('original-orphan'); CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,data TEXT); INSERT INTO session VALUES ('user-row','preserve-directory'); INSERT INTO part VALUES ('user-part','non-json-data')\");process.exit(0)",
      database,
    ]);
    await writeFile(
      join(plugin, "damaged.sqlite"),
      Buffer.concat([
        Buffer.from("SQLite format 3\u0000"),
        Buffer.from("original truncated user content"),
      ]),
    );
    const files = [
      "workspace/default/user.sqlite",
      "workspace/default/user.sqlite-wal",
      "workspace/default/user.sqlite-shm",
      "cli/plugins/cache/demo/damaged.sqlite",
    ];
    const originals = await Promise.all(files.map((path) => readFile(join(f.root, path))));
    expect(originals[1]!.length).toBeGreaterThan(0);
    const plan = await prepareDataDirectoryMigration({
      ...f,
      sources: [{ sourcePath: f.root, targetRelativePath: "" }],
    });
    await markDataDirectoryMigrationReady(f.homeDir, plan.id);
    const locator = await executeDataDirectoryMigration(f.homeDir);
    for (const [index, path] of files.entries()) {
      expect(await readFile(join(locator.root, path))).toEqual(originals[index]);
      expect(await readFile(join(f.root, path))).toEqual(originals[index]);
    }
  });

  it("没有 session 记录的工作区也能按新路径读取原 checkpoint", async () => {
    const f = await fixture();
    const workspace = join(f.root, "workspace", "default");
    await mkdir(workspace, { recursive: true });
    const original = {
      checkpointId: "checkpoint-1",
      workspacePath: workspace,
      repoRoot: workspace,
      workspaceInRepoPath: ".",
      createdAt: 1234,
      refName: "refs/zcode/checkpoints/one",
      commitOid: "a".repeat(40),
      scope: "workspace" as const,
    };
    await new GitCheckpointStore({ rootDir: join(f.root, "v2", "checkpoints") }).save(original);
    const plan = await prepareDataDirectoryMigration({
      ...f,
      sources: [{ sourcePath: f.root, targetRelativePath: "" }],
    });
    await markDataDirectoryMigrationReady(f.homeDir, plan.id);
    const locator = await executeDataDirectoryMigration(f.homeDir);
    const movedWorkspace = join(locator.root, "workspace", "default");
    const migrated = await new GitCheckpointStore({
      rootDir: join(locator.root, "v2", "checkpoints"),
    }).load(movedWorkspace, original.checkpointId);
    expect(migrated).toEqual({
      ...original,
      workspacePath: movedWorkspace,
      repoRoot: movedWorkspace,
    });
    const oldHash = createHash("sha256").update(workspace).digest("hex").slice(0, 12);
    expect(
      await readFile(
        join(f.root, "v2", "checkpoints", oldHash, original.checkpointId + ".json"),
        "utf8",
      ),
    ).toContain(workspace);
  });
  it("拒绝包括隐藏文件在内的非空目标，且不修改源与目标", async () => {
    const f = await fixture();
    await writeFile(join(f.targetBaseDir, ".keep"), "preserve");
    await expect(
      prepareDataDirectoryMigration({
        ...f,
        sources: [{ sourcePath: f.root, targetRelativePath: "" }],
      }),
    ).rejects.toMatchObject({ code: "DATA_DIRECTORY_TARGET_NOT_EMPTY" });
    expect(await readdir(f.targetBaseDir)).toEqual([".keep"]);
    expect(await readPendingDataDirectoryMigration(f.homeDir)).toBeNull();
  });

  it("prepared 没有干净关闭确认不能复制，取消后保留原目录", async () => {
    const f = await fixture();
    const plan = await prepareDataDirectoryMigration({
      ...f,
      sources: [{ sourcePath: f.root, targetRelativePath: "" }],
    });
    await expect(executeDataDirectoryMigration(f.homeDir)).rejects.toMatchObject({
      code: "DATA_DIRECTORY_NOT_READY",
    });
    expect(await readdir(f.targetBaseDir)).toEqual([]);
    await abortDataDirectoryMigration(f.homeDir, plan.id);
    expect(await readFile(join(f.root, "v2", "setting.json"), "utf8")).toContain("zh-CN");
  });

  it("整体迁移数据库、插件、产物与 workspace，修改受管路径且保留原文件", async () => {
    const f = await fixture();
    const oldWorkspace = join(f.root, "workspace", "default");
    const oldPlugin = join(f.root, "cli", "plugins", "cache", "demo");
    await mkdir(oldWorkspace, { recursive: true });
    await writeFile(join(oldWorkspace, "user.txt"), "user content");
    await mkdir(oldPlugin, { recursive: true });
    await writeFile(join(oldPlugin, "entry.js"), "plugin content");
    await writeFile(
      join(f.root, "cli", "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: [{ installPath: oldPlugin }] }),
    );
    await mkdir(join(f.root, "cli", "db"));
    const db = new DatabaseSync(join(f.root, "cli", "db", "db.sqlite"));
    db.exec(
      "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, path TEXT, workspace_id TEXT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, content TEXT)",
    );
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, NULL)").run(
      "sess_1",
      oldWorkspace
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80),
      oldWorkspace,
      oldWorkspace,
    );
    db.prepare("INSERT INTO message VALUES (?, ?, ?)").run("msg_1", "sess_1", "preserve history");
    db.close();
    const plan = await prepareDataDirectoryMigration({
      ...f,
      sources: [{ sourcePath: f.root, targetRelativePath: "" }],
    });
    await markDataDirectoryMigrationReady(f.homeDir, plan.id);
    const locator = await executeDataDirectoryMigration(f.homeDir);
    expect(locator.root).toBe(join(await realpath(f.targetBaseDir), ".zcode"));
    expect(await readFile(join(locator.root, "workspace", "default", "user.txt"), "utf8")).toBe(
      "user content",
    );
    expect(await readFile(join(oldWorkspace, "user.txt"), "utf8")).toBe("user content");
    expect(
      JSON.parse(
        await readFile(join(locator.root, "cli", "plugins", "installed_plugins.json"), "utf8"),
      ).plugins[0].installPath,
    ).toBe(join(locator.root, "cli", "plugins", "cache", "demo"));
    const copiedDb = new DatabaseSync(join(locator.root, "cli", "db", "db.sqlite"), {
      readOnly: true,
    });
    expect(copiedDb.prepare("SELECT content FROM message").get()).toEqual({
      content: "preserve history",
    });
    expect(copiedDb.prepare("SELECT directory FROM session").get()).toEqual({
      directory: join(locator.root, "workspace", "default"),
    });
    copiedDb.close();
    await expect(abortDataDirectoryMigration(f.homeDir, plan.id)).rejects.toMatchObject({
      code: "DATA_DIRECTORY_ALREADY_COMMITTED",
    });
  });

  it("首次归拢采用当前 App 根，不能由 HOME 的旧 v2 覆盖", async () => {
    const f = await fixture();
    const appBaseDir = join(f.homeDir, "existing-custom");
    await mkdir(join(appBaseDir, ".zcode", "v2"), { recursive: true });
    await writeFile(join(f.root, "v2", "current.json"), "old copy");
    await writeFile(join(appBaseDir, ".zcode", "v2", "current.json"), "current app data");
    await mkdir(join(f.root, "cli"));
    await writeFile(join(f.root, "cli", "config.json"), "{}");
    const sources = await discoverLegacyDataDirectorySources({ homeDir: f.homeDir, appBaseDir });
    const plan = await prepareDataDirectoryMigration({ ...f, sources });
    await markDataDirectoryMigrationReady(f.homeDir, plan.id);
    const locator = await executeDataDirectoryMigration(f.homeDir);
    expect(await readFile(join(locator.root, "v2", "current.json"), "utf8")).toBe(
      "current app data",
    );
    expect(await readFile(join(locator.root, "cli", "config.json"), "utf8")).toContain("storage");
    expect(await readFile(join(f.root, "v2", "current.json"), "utf8")).toBe("old copy");
  });

  it("ready 后目标被写入时拒绝迁移，源数据与外来目标文件都保留", async () => {
    const f = await fixture();
    const plan = await prepareDataDirectoryMigration({
      ...f,
      sources: [{ sourcePath: f.root, targetRelativePath: "" }],
    });
    await markDataDirectoryMigrationReady(f.homeDir, plan.id);
    await writeFile(join(f.targetBaseDir, "external.txt"), "keep");
    await expect(executeDataDirectoryMigration(f.homeDir)).rejects.toMatchObject({
      code: "DATA_DIRECTORY_TARGET_NOT_EMPTY",
    });
    expect(await readFile(join(f.targetBaseDir, "external.txt"), "utf8")).toBe("keep");
    expect(await readFile(join(f.root, "v2", "setting.json"), "utf8")).toContain("zh-CN");
  });

  it("独立 CLI lease 未释放时不能迁移，释放后才能执行", async () => {
    const f = await fixture();
    const lease = await acquireDataDirectoryUsageLease({ homeDir: f.homeDir, role: "test-cli" });
    try {
      const plan = await prepareDataDirectoryMigration({
        ...f,
        sources: [{ sourcePath: f.root, targetRelativePath: "" }],
      });
      await markDataDirectoryMigrationReady(f.homeDir, plan.id);
      await expect(executeDataDirectoryMigration(f.homeDir)).rejects.toThrow();
      expect(await readDataDirectoryLocator(f.homeDir)).toBeNull();
      expect(await readdir(f.targetBaseDir)).toEqual([]);
      await lease.release();
      expect((await executeDataDirectoryMigration(f.homeDir)).generation).toBe(plan.id);
    } finally {
      await lease.release();
    }
  });

  it("只读备份自行产生的空 WAL 不算来源数据变化，主库与空 sidecar 均保留", async () => {
    const f = await fixture();
    const path = join(f.root, "cli", "db", "db.sqlite");
    await mkdir(join(f.root, "cli", "db"), { recursive: true });
    const source = new DatabaseSync(path);
    source.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE record(id TEXT PRIMARY KEY); INSERT INTO record VALUES ('checkpointed')",
    );
    source.close();
    const original = await readFile(path);
    await expect(readFile(path + "-wal")).rejects.toMatchObject({ code: "ENOENT" });
    const plan = await prepareDataDirectoryMigration({
      ...f,
      sources: [{ sourcePath: f.root, targetRelativePath: "" }],
    });
    await markDataDirectoryMigrationReady(f.homeDir, plan.id);
    const locator = await executeDataDirectoryMigration(f.homeDir);
    // 本机真实 SQLite readOnly/backup 会创建空 WAL；不能靠删除源 sidecar 消除误报。
    expect((await readFile(path + "-wal")).length).toBe(0);
    expect(await readFile(path)).toEqual(original);
    const migrated = new DatabaseSync(join(locator.root, "cli", "db", "db.sqlite"), {
      readOnly: true,
    });
    try {
      expect(migrated.prepare("SELECT id FROM record").get()).toEqual({ id: "checkpointed" });
    } finally {
      migrated.close();
    }
  });

  it("SQLite backup 包含尚未 checkpoint 的已提交 WAL 数据", async () => {
    const f = await fixture();
    const path = join(f.root, "cli", "db", "db.sqlite");
    await mkdir(join(f.root, "cli", "db"), { recursive: true });
    await promisify(execFile)(process.execPath, [
      "-e",
      "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec(\"PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE record(id TEXT);INSERT INTO record VALUES ('wal-only')\");process.exit(0)",
      path,
    ]);
    expect((await readFile(path + "-wal")).length).toBeGreaterThan(0);
    const plan = await prepareDataDirectoryMigration({
      ...f,
      sources: [{ sourcePath: f.root, targetRelativePath: "" }],
    });
    await markDataDirectoryMigrationReady(f.homeDir, plan.id);
    const locator = await executeDataDirectoryMigration(f.homeDir);
    const db = new DatabaseSync(join(locator.root, "cli", "db", "db.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("SELECT id FROM record").get()).toEqual({ id: "wal-only" });
    } finally {
      db.close();
    }
  });

  it("相同主文件但不同 WAL 的两份数据库不能静默合并", async () => {
    const f = await fixture();
    const a = join(f.homeDir, "a.sqlite");
    const b = join(f.homeDir, "b.sqlite");
    const db = new DatabaseSync(a);
    db.exec("CREATE TABLE record(id TEXT)");
    db.close();
    await copyFile(a, b);
    for (const [path, value] of [
      [a, "first"],
      [b, "second"],
    ]) {
      await promisify(execFile)(process.execPath, [
        "-e",
        "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0');d.prepare('INSERT INTO record VALUES (?)').run(process.argv[2]);process.exit(0)",
        path!,
        value!,
      ]);
    }
    expect(await readFile(a)).toEqual(await readFile(b));
    const plan = await prepareDataDirectoryMigration({
      ...f,
      sources: [
        { sourcePath: a, targetRelativePath: "cli/db/db.sqlite" },
        { sourcePath: b, targetRelativePath: "cli/db/db.sqlite" },
      ],
    });
    await markDataDirectoryMigrationReady(f.homeDir, plan.id);
    await expect(executeDataDirectoryMigration(f.homeDir)).rejects.toMatchObject({
      code: "DATA_DIRECTORY_SOURCE_CONFLICT",
    });
    expect(await readDataDirectoryLocator(f.homeDir)).toBeNull();
  });

  it("复制中断留下的本事务 staging 可安全重做，旧数据不删除", async () => {
    const f = await fixture();
    const plan = await prepareDataDirectoryMigration({
      ...f,
      sources: [{ sourcePath: f.root, targetRelativePath: "" }],
    });
    await markDataDirectoryMigrationReady(f.homeDir, plan.id);
    await writeFile(
      getDataDirectoryControlPaths(f.homeDir).journal,
      JSON.stringify({ ...plan, phase: "copying" }),
    );
    await mkdir(plan.stagingRoot);
    await writeFile(
      join(plan.stagingRoot, ".migration-owner.json"),
      JSON.stringify({ id: plan.id }),
    );
    await writeFile(join(plan.stagingRoot, "partial"), "incomplete");
    const locator = await executeDataDirectoryMigration(f.homeDir);
    expect(await readFile(join(locator.root, "v2", "setting.json"), "utf8")).toContain("zh-CN");
    expect(await readdir(locator.root)).not.toContain("partial");
  });

  it("提交后 journal 落后可补齐，不能覆盖新根后续产生的数据", async () => {
    const f = await fixture();
    const plan = await prepareDataDirectoryMigration({
      ...f,
      sources: [{ sourcePath: f.root, targetRelativePath: "" }],
    });
    await markDataDirectoryMigrationReady(f.homeDir, plan.id);
    const locator = await executeDataDirectoryMigration(f.homeDir);
    await writeFile(join(locator.root, "new-message.json"), '{"new":true}');
    const journal = await readPendingDataDirectoryMigration(f.homeDir);
    await writeFile(
      getDataDirectoryControlPaths(f.homeDir).journal,
      JSON.stringify({ ...journal, phase: "verified" }),
    );
    await beginDataDirectoryMaintenance({ homeDir: f.homeDir, migrationId: plan.id });
    expect(await executeDataDirectoryMigration(f.homeDir)).toEqual(locator);
    expect(await readFile(join(locator.root, "new-message.json"), "utf8")).toBe('{"new":true}');
  });

  it("保留可解密凭据并迁移 settings 的本地工作区键，远端 identity 和正文保持原样", async () => {
    const f = await fixture();
    const workspace = join(f.root, "workspace", "default");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(f.root, "v2", "credentials.json"),
      JSON.stringify({ test: createCredentialCipherProvider().encrypt("synthetic-value") }),
    );
    await writeFile(
      join(f.root, "v2", "setting.json"),
      JSON.stringify({
        lastActiveTaskByWorkspace: { [workspace]: "local-task", "ssh:remote": "remote-task" },
        lastWorkspaceSession: [
          { workspacePath: workspace },
          { workspaceIdentity: "ssh:remote", workspacePath: workspace },
        ],
      }),
    );
    const plan = await prepareDataDirectoryMigration({
      ...f,
      sources: [{ sourcePath: f.root, targetRelativePath: "" }],
    });
    await markDataDirectoryMigrationReady(f.homeDir, plan.id);
    const locator = await executeDataDirectoryMigration(f.homeDir);
    const settings = JSON.parse(await readFile(join(locator.root, "v2", "setting.json"), "utf8"));
    expect(settings.lastActiveTaskByWorkspace).toEqual({
      [join(locator.root, "workspace", "default")]: "local-task",
      "ssh:remote": "remote-task",
    });
    expect(settings.lastWorkspaceSession).toEqual([
      { workspacePath: join(locator.root, "workspace", "default") },
      { workspaceIdentity: "ssh:remote", workspacePath: workspace },
    ]);
    const credentials = JSON.parse(
      await readFile(join(locator.root, "v2", "credentials.json"), "utf8"),
    );
    expect(createCredentialCipherProvider().decrypt(credentials.test)).toBe("synthetic-value");
  });

  it("损坏凭据或缺失的受管插件引用阻止提交", async () => {
    const f = await fixture();
    await writeFile(
      join(f.root, "v2", "credentials.json"),
      JSON.stringify({ test: "enc:v1:broken" }),
    );
    const plan = await prepareDataDirectoryMigration({
      ...f,
      sources: [{ sourcePath: f.root, targetRelativePath: "" }],
    });
    await markDataDirectoryMigrationReady(f.homeDir, plan.id);
    await expect(executeDataDirectoryMigration(f.homeDir)).rejects.toMatchObject({
      code: "DATA_DIRECTORY_CREDENTIALS_UNREADABLE",
    });
    expect(await readDataDirectoryLocator(f.homeDir)).toBeNull();
  });

  it("内部目录链接跟随新根，不会被静默跳过", async () => {
    const f = await fixture();
    const source = join(f.root, "skills", "demo");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "synthetic skill");
    await symlink(
      source,
      join(f.root, "skill-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const plan = await prepareDataDirectoryMigration({
      ...f,
      sources: [{ sourcePath: f.root, targetRelativePath: "" }],
    });
    await markDataDirectoryMigrationReady(f.homeDir, plan.id);
    const locator = await executeDataDirectoryMigration(f.homeDir);
    expect(await readFile(join(locator.root, "skill-link", "SKILL.md"), "utf8")).toBe(
      "synthetic skill",
    );
  });

  it("后续迁移只使用当前完整根，带走迁移后新增数据", async () => {
    const f = await fixture();
    const first = await prepareDataDirectoryMigration({
      ...f,
      sources: [{ sourcePath: f.root, targetRelativePath: "" }],
    });
    await markDataDirectoryMigrationReady(f.homeDir, first.id);
    const firstLocator = await executeDataDirectoryMigration(f.homeDir);
    await writeFile(join(firstLocator.root, "new-data.txt"), "after first move");
    const targetBaseDir = join(f.homeDir, "second");
    await mkdir(targetBaseDir);
    const sources = await discoverLegacyDataDirectorySources({
      homeDir: f.homeDir,
      appBaseDir: f.homeDir,
    });
    expect(sources).toHaveLength(1);
    expect(sources[0]?.sourcePath).toBe(firstLocator.root);
    const second = await prepareDataDirectoryMigration({
      homeDir: f.homeDir,
      targetBaseDir,
      sources,
    });
    await markDataDirectoryMigrationReady(f.homeDir, second.id);
    const secondLocator = await executeDataDirectoryMigration(f.homeDir);
    expect(await readFile(join(secondLocator.root, "new-data.txt"), "utf8")).toBe(
      "after first move",
    );
    expect(await readFile(join(firstLocator.root, "new-data.txt"), "utf8")).toBe(
      "after first move",
    );
  });
});
