import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import type { ElectronMock } from "@wdio/electron-types";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_DATA_BASE_DIR_BROWSE,
  TID_SETTINGS_DATA_BASE_DIR_INPUT,
  TID_SETTINGS_DATA_BASE_DIR_SAVE,
  TID_SETTINGS_DATA_BASE_DIR_STATUS,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  ensureWorkspaceItemExpanded,
  getE2EAppDataPaths,
  waitForDefaultWorkspaceReady,
  waitForWorkspaceApp,
} from "../helpers/desktop-app.js";
import { closeE2EElectronServiceBridge } from "../helpers/e2e-electron-service-lifecycle.js";
import { reloadElectronSessionSafely } from "../helpers/e2e-electron-reload.js";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const CASE_TIMEOUT_MS = 240_000;
const BEFORE_MARKER = "E2E_CDD01_BEFORE_MIGRATION";
const BEFORE_REPLY = "CDD01_BEFORE_MIGRATION_DONE";
const AFTER_MARKER = "E2E_CDD01_AFTER_MIGRATION";
const AFTER_REPLY = "CDD01_AFTER_MIGRATION_DONE";
const APP_CANARY_NAME = "e2e-cdd01-app-canary.txt";
const APP_CANARY_CONTENT = "CDD01_APP_DATA_CANARY\n";
const PROJECT_CANARY_CONTENT = "CDD01_PROJECT_DATA_CANARY\n";
const paths = getE2EAppDataPaths();
const driverBootstrapDir = join(paths.homeDir, "cdd01-driver-bootstrap-profile");
const customDataBaseDir = join(paths.homeDir, "cdd01-custom-data-root");
const customAppDataDir = join(customDataBaseDir, ".zcode", "v2");
const oldTasksIndex = join(paths.appDataDir, "tasks-index.sqlite");
const customTasksIndex = join(customAppDataDir, "tasks-index.sqlite");
const controlDir = join(paths.homeDir, ".zcode-data-directory");
const locatorFile = join(controlDir, "active.json");
const pluginCanary = join(paths.homeDir, ".zcode", "plugins", "e2e-cdd01-canary.txt");
const PROFILE_CANARY_KEY = "e2e-cdd01-profile-canary";
const cliDatabase = join(paths.homeDir, ".zcode", "cli", "db", "db.sqlite");
const customCliRoot = join(customDataBaseDir, ".zcode", "cli");
const projectCanary = join(paths.workspace, ".zcode", "e2e-cdd01-project-canary.txt");

describe("CDD01：修改数据存储路径后原任务仍可继续", () => {
  let showOpenDialogMock: ElectronMock | null = null;
  let originalUserDataDir = "";

  after(async function () {
    this.timeout(120_000);
    await browser.electron.restoreAllMocks();
    if (await pathExists(locatorFile)) {
      await configureMigrationRestart(originalUserDataDir);
      // 测试 fixture 也遵守退出屏障，不能在新根仍有进程写入时删除 locator 或目录。
      await reloadElectronSessionSafely(browser, {
        cleanupTimedOutProcessTreePids: rejectTimedOutMigrationProcesses,
        afterElectronProcessExit: async () => {
          await rm(controlDir, { force: true, recursive: true });
          await rm(customDataBaseDir, { force: true, recursive: true });
        },
      });
      await waitForDefaultWorkspaceReady(60_000);
    }
    await clearAppData();
    await rm(customDataBaseDir, { force: true, recursive: true });
    await rm(driverBootstrapDir, { force: true, recursive: true });
    await rm(projectCanary, { force: true });
    await rm(pluginCanary, { force: true });
  });

  it("空目标迁移并冷重启后会话、CLI、插件和浏览器状态完整，旧副本停止写入", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    // 目录迁移不测试职业引导；复用真实 Escape 关闭引导的工作区就绪流程，避免 Skip 动画遮挡。
    await waitForWorkspaceApp(paths.workspace, 60_000);
    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });
    await sendV4Prompt(BEFORE_MARKER);
    await waitForV4TimelineContaining(BEFORE_REPLY, 60_000);
    const sessionId = await waitForCompletedSession();

    await rm(customDataBaseDir, { force: true, recursive: true });
    await mkdir(customDataBaseDir, { recursive: true });
    expect(await readdir(customDataBaseDir)).toEqual([]);
    await writeFile(join(paths.appDataDir, APP_CANARY_NAME), APP_CANARY_CONTENT, "utf8");
    await mkdir(dirname(projectCanary), { recursive: true });
    await writeFile(projectCanary, PROJECT_CANARY_CONTENT, "utf8");
    expect(await pathExists(cliDatabase)).toBe(true);
    await mkdir(dirname(pluginCanary), { recursive: true });
    await writeFile(pluginCanary, APP_CANARY_CONTENT, "utf8");
    await browser.execute(
      (key) => window.localStorage.setItem(key, "CDD01_PROFILE"),
      PROFILE_CANARY_KEY,
    );
    originalUserDataDir = await browser.electron.execute((electron) =>
      electron.app.getPath("userData"),
    );
    // WDIO 保留关闭/重建协议连接的所有权，产品仍完成真实 clean ACK 和 ready journal。
    const relaunchMock = await browser.electron.mock("app", "relaunch");
    const quitMock = await browser.electron.mock("app", "quit");
    const failureDialog = await browser.electron.mock("dialog", "showMessageBox");
    await failureDialog.mockResolvedValue({ response: 0, checkboxChecked: false });
    await relaunchMock.mockResolvedValue(undefined);
    await quitMock.mockResolvedValue(undefined);

    showOpenDialogMock = await browser.electron.mock("dialog", "showOpenDialog");
    await showOpenDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePaths: [customDataBaseDir],
    });

    await openGeneralSettings();
    expect(await readDataBaseDirInput()).toBe(paths.homeDir);
    await clickTestIdByDom(TID_SETTINGS_DATA_BASE_DIR_BROWSE, {
      timeout: 15_000,
      timeoutMsg: "CDD01 数据目录选择按钮不可点击",
    });
    await browser.waitUntil(async () => (await readDataBaseDirInput()) === customDataBaseDir, {
      timeout: 15_000,
      timeoutMsg: "CDD01 系统目录选择结果没有写入只读路径框",
    });
    const occupiedTargetFile = join(customDataBaseDir, ".occupied");
    await writeFile(occupiedTargetFile, "must not be overwritten", "utf8");
    await clickTestIdByDom(TID_SETTINGS_DATA_BASE_DIR_SAVE, {
      timeout: 15_000,
      timeoutMsg: "CDD01 迁移按钮不可点击",
    });
    await browser.waitUntil(
      async () =>
        browser.execute(
          (id) =>
            document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.dataset.state === "error",
          TID_SETTINGS_DATA_BASE_DIR_STATUS,
        ),
      {
        timeout: 15_000,
        timeoutMsg: "CDD01 非空目标没有被拒绝",
      },
    );
    expect(await readFile(occupiedTargetFile, "utf8")).toBe("must not be overwritten");
    expect(await pathExists(locatorFile)).toBe(false);
    await rm(occupiedTargetFile);
    await clickTestIdByDom(TID_SETTINGS_DATA_BASE_DIR_SAVE, {
      timeout: 15_000,
      timeoutMsg: "CDD01 数据目录保存按钮不可点击",
    });
    await waitForDataBaseDirSaved();

    const journal = JSON.parse(await readFile(join(controlDir, "transaction.json"), "utf8")) as {
      phase: string;
    };
    expect(journal.phase).toBe("ready");
    // 尚未完整退出时不得复制任何业务文件，尤其是 Chromium profile。
    expect(await pathExists(customAppDataDir)).toBe(false);
    await browser.electron.restoreAllMocks();
    await mkdir(driverBootstrapDir, { recursive: true });
    await configureMigrationRestart(driverBootstrapDir);
    await reloadElectronSessionSafely(browser, {
      cleanupTimedOutProcessTreePids: rejectTimedOutMigrationProcesses,
      requestPreparedAppExit: async () => {
        // 产品已严格关库并 flush；先由 helper 捕获全部旧 PID，再退出，避免 mock quit 事件重入。
        await browser.electron.execute((electron) => {
          setImmediate(() => electron.app.exit(0));
        });
        // Main Inspector 属于测试 worker；从连接 owner 关闭 socket，不能在 Main 同步等自己断开。
        await closeE2EElectronServiceBridge(browser);
      },
    });
    await waitForDefaultWorkspaceReady(60_000);
    await waitForWorkspaceApp(paths.workspace, 60_000);

    expect(await readActiveDataBaseDir()).toBe(customDataBaseDir);
    expect(await readFile(join(customAppDataDir, APP_CANARY_NAME), "utf8")).toBe(
      APP_CANARY_CONTENT,
    );
    expect(await pathExists(customTasksIndex)).toBe(true);
    expect(await pathExists(join(customAppDataDir, "setting.json"))).toBe(true);
    expect(await pathExists(join(customCliRoot, "db", "db.sqlite"))).toBe(true);
    expect(
      await readFile(join(customDataBaseDir, ".zcode", "plugins", "e2e-cdd01-canary.txt"), "utf8"),
    ).toBe(APP_CANARY_CONTENT);
    expect(await readFile(projectCanary, "utf8")).toBe(PROJECT_CANARY_CONTENT);
    expect(
      await browser.execute((key) => window.localStorage.getItem(key), PROFILE_CANARY_KEY),
    ).toBe("CDD01_PROFILE");
    const oldCliHash = createHash("sha256")
      .update(await readFile(cliDatabase))
      .digest("hex");

    await ensureWorkspaceItemExpanded(DEFAULT_WORKSPACE);
    await selectV4TaskById(sessionId);
    await waitForV4TimelineContaining(BEFORE_MARKER, 60_000);
    await waitForV4TimelineContaining(BEFORE_REPLY, 60_000);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionId && !snapshot.canStop,
      "CDD01 冷重启后原任务没有恢复到 idle",
      60_000,
    );

    await openGeneralSettings();
    expect(await readDataBaseDirInput()).toBe(customDataBaseDir);
    await closeSettings(sessionId);

    const oldUpdatedAtBeforeFollowup = readTaskUpdatedAt(oldTasksIndex, sessionId);
    const customUpdatedAtBeforeFollowup = readTaskUpdatedAt(customTasksIndex, sessionId);
    expect(oldUpdatedAtBeforeFollowup).not.toBeNull();
    expect(customUpdatedAtBeforeFollowup).not.toBeNull();

    await sendV4Prompt(AFTER_MARKER);
    await waitForV4TimelineContaining(AFTER_REPLY, 60_000);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionId && !snapshot.canStop,
      "CDD01 新路径下的同任务 follow-up 没有完成",
      60_000,
    );
    await waitForTaskIndexAdvance(
      customTasksIndex,
      sessionId,
      customUpdatedAtBeforeFollowup as number,
    );

    expect(readTaskUpdatedAt(oldTasksIndex, sessionId)).toBe(oldUpdatedAtBeforeFollowup);
    expect(await pathExists(cliDatabase)).toBe(true);
    expect(await pathExists(customCliRoot)).toBe(true);
    expect(
      createHash("sha256")
        .update(await readFile(cliDatabase))
        .digest("hex"),
    ).toBe(oldCliHash);
    expect(await readFile(projectCanary, "utf8")).toBe(PROJECT_CANARY_CONTENT);
  });
});

async function waitForCompletedSession(): Promise<string> {
  const snapshot = await waitForV4Pane(
    (current) => Boolean(current.sessionId && current.sessionId !== "draft" && !current.canStop),
    "CDD01 迁移前任务没有完成",
    60_000,
  );
  if (!snapshot.sessionId || snapshot.sessionId === "draft") {
    throw new Error(`CDD01 缺少迁移前 sessionId: ${String(snapshot.sessionId)}`);
  }
  return snapshot.sessionId;
}

async function openGeneralSettings(): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "CDD01 没有找到设置入口",
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        (settingsPageTestId) =>
          Boolean(document.querySelector(`[data-testid="${settingsPageTestId}"]`)),
        TID_SETTINGS_PAGE,
      ),
    { timeout: 15_000, timeoutMsg: "CDD01 设置页没有打开" },
  );
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"), {
    timeout: 15_000,
    timeoutMsg: "CDD01 设置页没有常规分区入口",
  });
  await browser.waitUntil(async () => (await readDataBaseDirInput()) !== null, {
    timeout: 15_000,
    timeoutMsg: "CDD01 常规设置没有数据存储路径控件",
  });
}

async function closeSettings(expectedSessionId: string): Promise<void> {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "CDD01 设置页返回按钮没有出现",
  });
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === expectedSessionId,
    `CDD01 返回工作区后没有恢复 Session ${expectedSessionId}`,
    30_000,
  );
}

function readDataBaseDirInput(): Promise<string | null> {
  return browser.execute((inputTestId) => {
    const input = document.querySelector<HTMLInputElement>(`[data-testid="${inputTestId}"]`);
    return input?.value ?? null;
  }, TID_SETTINGS_DATA_BASE_DIR_INPUT);
}

async function waitForDataBaseDirSaved(): Promise<void> {
  let outcome: { state?: string; text?: string } = {};
  await browser.waitUntil(
    async () => {
      outcome = await browser.execute((statusTestId) => {
        const status = document.querySelector<HTMLElement>(`[data-testid="${statusTestId}"]`);
        return { state: status?.dataset.state, text: status?.textContent ?? "" };
      }, TID_SETTINGS_DATA_BASE_DIR_STATUS);
      return outcome.state === "saved" || outcome.state === "error";
    },
    { timeout: 60_000, timeoutMsg: "CDD01 数据复制没有进入待重启状态" },
  );
  if (outcome.state === "error") throw new Error(`CDD01 migration rejected: ${outcome.text}`);
}

async function readActiveDataBaseDir(): Promise<string | null> {
  const locator = JSON.parse(await readFile(locatorFile, "utf8")) as { root?: unknown };
  return typeof locator.root === "string" ? dirname(locator.root) : null;
}

async function configureMigrationRestart(userDataDir: string): Promise<void> {
  // 指定 CDP 端口避免 ChromeDriver 先在空目标写 DevToolsActivePort；profile 迁移由真实启动入口完成。
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No CDP port available");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const capabilities = browser.requestedCapabilities as WebdriverIO.Capabilities & {
    "goog:chromeOptions"?: { args?: string[] };
  };
  const options = capabilities["goog:chromeOptions"] ?? {};
  capabilities["goog:chromeOptions"] = {
    ...options,
    args: [
      ...(options.args ?? []).filter(
        (arg) => !arg.startsWith("--user-data-dir=") && !arg.startsWith("--remote-debugging-port="),
      ),
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${port}`,
    ],
  };
}

function readTaskUpdatedAt(databasePath: string, sessionId: string): number | null {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const row = database
      .prepare("SELECT updated_at FROM tasks WHERE task_id = ? LIMIT 1")
      .get(sessionId) as { updated_at: number } | undefined;
    return row?.updated_at ?? null;
  } finally {
    database.close();
  }
}

async function waitForTaskIndexAdvance(
  databasePath: string,
  sessionId: string,
  previousUpdatedAt: number,
): Promise<void> {
  let latest: number | null = null;
  await browser.waitUntil(
    async () => {
      latest = readTaskUpdatedAt(databasePath, sessionId);
      return latest !== null && latest > previousUpdatedAt;
    },
    {
      timeout: 30_000,
      timeoutMsg: `CDD01 新 App 根 task-index 没有推进: previous=${previousUpdatedAt}; latest=${String(latest)}`,
    },
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function rejectTimedOutMigrationProcesses(pids: number[]): Promise<void> {
  // 搬盘验收不能用超时强杀冒充完整退出，也不能在存活 writer 上继续删除 fixture 数据。
  const processStates =
    process.platform === "win32"
      ? ""
      : execFileSync("ps", ["-o", "pid=,ppid=,stat=,comm=", "-p", pids.join(",")], {
          encoding: "utf8",
        });
  throw new Error(`CDD01 process exit was not confirmed: ${pids.join(",")}\n${processStates}`);
}
