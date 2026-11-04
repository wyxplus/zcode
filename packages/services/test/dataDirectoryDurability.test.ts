import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readDataDirectoryLocator } from "@zcode/shared/data-directory";
import {
  abortDataDirectoryMigration,
  executeDataDirectoryMigration,
  markDataDirectoryMigrationReady,
  prepareDataDirectoryMigration,
  readPendingDataDirectoryMigration,
} from "../src/data-directory/index.js";

const io = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  io.open.mockImplementation(actual.open);
  return { ...actual, open: io.open };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const directories: string[] = [];

afterEach(async () => {
  io.open.mockReset().mockImplementation(actualFs.open);
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const homeDir = await realpath(await mkdtemp(join(tmpdir(), "zcode-data-durability-")));
  directories.push(homeDir);
  const root = join(homeDir, ".zcode");
  const targetBaseDir = join(homeDir, "target");
  await mkdir(join(root, "v2"), { recursive: true });
  await mkdir(join(root, "cli", "plugins", "demo"), { recursive: true });
  await mkdir(join(root, "cli", "cache"), { recursive: true });
  await mkdir(targetBaseDir);
  const files = new Map([
    [join("v2", "setting.json"), Buffer.from('{"locale":"zh-CN"}\n')],
    [join("cli", "plugins", "demo", "plugin.bin"), Buffer.from([0, 1, 127, 255])],
    [join("cli", "cache", "empty"), Buffer.alloc(0)],
  ]);
  for (const [path, content] of files) await writeFile(join(root, path), content);
  return { homeDir, root, targetBaseDir, files };
}

async function prepare(homeDir: string, root: string, targetBaseDir: string) {
  const plan = await prepareDataDirectoryMigration({
    homeDir,
    targetBaseDir,
    sources: [{ sourcePath: root, targetRelativePath: "" }],
  });
  await markDataDirectoryMigrationReady(homeDir, plan.id);
  return plan;
}

function fsyncError(code: string) {
  return Object.assign(new Error(`${code}: operation not permitted, fsync`), {
    code,
    syscall: "fsync",
  });
}

function failFinalFlush(stagingRoot: string, error: Error) {
  const marker = join(stagingRoot, ".migration-owner.json");
  let failedHandleClosed = false;
  io.open.mockImplementation(async (...args: Parameters<typeof actualFs.open>) => {
    const handle = await actualFs.open(...args);
    if (String(args[0]) === marker) {
      vi.spyOn(handle, "sync").mockRejectedValue(error);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        failedHandleClosed = true;
      });
    }
    return handle;
  });
  return () => failedHandleClosed;
}

describe("数据迁移落盘与恢复", () => {
  it("Windows 拒绝只读句柄 flush 时仍完整迁移，保留二进制、空文件与源内容", async () => {
    const f = await fixture();
    const plan = await prepare(f.homeDir, f.root, f.targetBaseDir);
    const flushed = new Set<string>();
    // Windows 的 FlushFileBuffers 要求 GENERIC_WRITE；在其他平台也重现这一系统约束。
    io.open.mockImplementation(async (...args: Parameters<typeof actualFs.open>) => {
      const handle = await actualFs.open(...args);
      if ((await handle.stat()).isFile()) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          if (args[1] === "r") throw fsyncError("EPERM");
          await sync();
          flushed.add(String(args[0]));
        });
      }
      return handle;
    });
    const locator = await executeDataDirectoryMigration(f.homeDir);
    expect(locator.generation).toBe(plan.id);
    expect(flushed.has(join(plan.stagingRoot, ".migration-owner.json"))).toBe(true);
    for (const [path, content] of f.files) {
      expect(await readFile(join(f.root, path))).toEqual(content);
      if (path.endsWith("setting.json")) {
        expect(JSON.parse(await readFile(join(locator.root, path), "utf8")).locale).toBe("zh-CN");
      } else {
        expect(await readFile(join(locator.root, path))).toEqual(content);
      }
    }
  });

  it("最终 flush 失败不切换已有 locator、不修改源；同一事务可以安全重试", async () => {
    const f = await fixture();
    await prepare(f.homeDir, f.root, f.targetBaseDir);
    const previous = await executeDataDirectoryMigration(f.homeDir);
    const nextTarget = join(f.homeDir, "next-target");
    await mkdir(nextTarget);
    const plan = await prepare(f.homeDir, previous.root, nextTarget);
    const before = await readFile(join(previous.root, "v2", "setting.json"));
    const failure = fsyncError("EIO");
    const wasClosed = failFinalFlush(plan.stagingRoot, failure);
    await expect(executeDataDirectoryMigration(f.homeDir)).rejects.toBe(failure);
    expect(wasClosed()).toBe(true);
    expect(await readDataDirectoryLocator(f.homeDir)).toEqual(previous);
    expect(await readPendingDataDirectoryMigration(f.homeDir)).toMatchObject({
      id: plan.id,
      phase: "copying",
    });
    expect(await readFile(join(previous.root, "v2", "setting.json"))).toEqual(before);

    io.open.mockReset().mockImplementation(actualFs.open);
    const migrated = await executeDataDirectoryMigration(f.homeDir);
    expect(migrated.generation).toBe(plan.id);
    expect(await readDataDirectoryLocator(f.homeDir)).toEqual(migrated);
    expect(await readPendingDataDirectoryMigration(f.homeDir)).toMatchObject({
      id: plan.id,
      phase: "committed",
    });
    expect(await readFile(join(previous.root, "v2", "setting.json"))).toEqual(before);
    expect(
      JSON.parse(await readFile(join(migrated.root, "v2", "setting.json"), "utf8")).locale,
    ).toBe("zh-CN");
  });

  it("EPERM 不能被忽略，取消失败迁移仍保留源和受管 staging", async () => {
    const f = await fixture();
    const plan = await prepare(f.homeDir, f.root, f.targetBaseDir);
    const failure = fsyncError("EPERM");
    failFinalFlush(plan.stagingRoot, failure);
    await expect(executeDataDirectoryMigration(f.homeDir)).rejects.toBe(failure);
    await abortDataDirectoryMigration(f.homeDir, plan.id);
    expect(await readDataDirectoryLocator(f.homeDir)).toBeNull();
    expect(await readPendingDataDirectoryMigration(f.homeDir)).toBeNull();
    for (const [path, content] of f.files) {
      expect(await readFile(join(f.root, path))).toEqual(content);
      await expect(readFile(join(plan.stagingRoot, path))).resolves.toBeInstanceOf(Buffer);
    }
  });
});
