import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotInboundMessage,
  BotProvider,
  BotsConfigFile,
  ZCodeStreamEvent,
} from "@zcode/shared";
import * as f from "./botsService.fixtures.js";

const runtime = vi.hoisted(() => ({
  dispose: vi.fn<() => Promise<void>>(),
  refresh: vi.fn<() => Promise<void>>(),
  inbound: undefined as undefined | ((provider: BotProvider, payload: unknown) => Promise<unknown>),
}));
vi.mock("../src/bots/telegramChannelRuntime.js", () => ({
  createTelegramChannelRuntime: (ports: { processProviderCallback: typeof runtime.inbound }) => {
    runtime.inbound = ports.processProviderCallback;
    return { dispose: runtime.dispose, refresh: runtime.refresh, scheduleRefresh: vi.fn() };
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const disabledConfig: BotsConfigFile = {
  ...f.baseConfig,
  bots: f.baseConfig.bots.map((bot) => ({ ...bot, enabled: false })),
};
const ignoredMessage: BotInboundMessage = {
  botId: "webhook-1",
  text: "kept input",
  senderType: "app",
  actor: {
    botId: "webhook-1",
    provider: "webhook",
    providerUserId: "user-1",
    chatType: "group",
    chatId: "group-1",
  },
};
function createService(repo = f.createMemoryRepo(disabledConfig), startup = false) {
  return f.createBotsService({
    repo: repo as never,
    credentialService: f.createCredentialService(),
    runStartupBackgroundTasks: startup,
  });
}

beforeEach(() => {
  runtime.dispose.mockReset().mockResolvedValue();
  runtime.refresh.mockReset().mockResolvedValue();
  runtime.inbound = undefined;
});

describe("Bot data-directory reservation", () => {
  it("reserves without closing providers, gates native and RPC ingress, and cancellation restores them", async () => {
    const service = createService();
    try {
      await service.reserveForDataDirectoryMigration();
      expect(runtime.dispose).not.toHaveBeenCalled();
      await expect(service.handleInboundMessage(ignoredMessage)).rejects.toThrow("MAINTENANCE");
      await expect(service.handleProviderCallback("discord", {})).rejects.toThrow("MAINTENANCE");
      await expect(service.handleProviderCallbackResponse("discord", {})).rejects.toThrow(
        "MAINTENANCE",
      );
      await expect(runtime.inbound!("discord", {})).rejects.toThrow("MAINTENANCE");
      service.cancelDataDirectoryMigration();
      await expect(service.handleInboundMessage(ignoredMessage)).resolves.toEqual([]);
      await expect(runtime.inbound!("discord", {})).resolves.toMatchObject({ status: 400 });
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("requires all enabled bots to be disabled before migration", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const service = createService(repo);
    try {
      await expect(service.reserveForDataDirectoryMigration()).rejects.toThrow(
        "Stop all enabled Bots",
      );
      expect((await repo.readConfig()).bots[0]?.enabled).toBe(true);
      expect(runtime.dispose).not.toHaveBeenCalled();
      service.cancelDataDirectoryMigration();
      await expect(service.handleInboundMessage(ignoredMessage)).resolves.toEqual([]);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("seals before the asynchronous config check can admit another message", async () => {
    const repo = f.createMemoryRepo(disabledConfig);
    const config = deferred<BotsConfigFile>();
    vi.spyOn(repo, "readConfig").mockReturnValueOnce(config.promise);
    const service = createService(repo);
    try {
      const reserve = service.reserveForDataDirectoryMigration();
      await expect(service.handleInboundMessage(ignoredMessage)).rejects.toThrow("MAINTENANCE");
      config.resolve(disabledConfig);
      await reserve;
      expect(runtime.dispose).not.toHaveBeenCalled();
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("does not clear an accepted call that has not reached its inbound queue", async () => {
    const repo = f.createMemoryRepo(disabledConfig);
    const read = deferred<Awaited<ReturnType<typeof repo.readState>>>();
    vi.spyOn(repo, "readState").mockReturnValueOnce(read.promise);
    const service = createService(repo);
    try {
      const accepted = service.handleInboundMessage(ignoredMessage);
      await expect(service.reserveForDataDirectoryMigration()).rejects.toThrow(
        "DATA_DIRECTORY_BUSY",
      );
      expect(runtime.dispose).not.toHaveBeenCalled();
      service.cancelDataDirectoryMigration();
      read.resolve({ version: 3, bots: {} });
      await expect(accepted).resolves.toEqual([]);
      await expect(service.handleInboundMessage(ignoredMessage)).resolves.toEqual([]);
      await expect(service.reserveForDataDirectoryMigration()).resolves.toBeUndefined();
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("lets an accepted native callback finish its internal dispatch while new admission is sealed", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const config = deferred<BotsConfigFile>();
    const started = deferred<void>();
    vi.spyOn(repo, "readConfig").mockImplementationOnce(() => {
      started.resolve();
      return config.promise;
    });
    const service = f.createBotsService({
      repo: repo as never,
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      runStartupBackgroundTasks: false,
    });
    try {
      const accepted = runtime.inbound!("webhook", {
        botId: "webhook-1",
        userId: "user-1",
        webhookSecret: "secret",
        text: "/help",
      });
      await started.promise;
      await expect(service.reserveForDataDirectoryMigration()).rejects.toThrow(
        "DATA_DIRECTORY_BUSY",
      );
      config.resolve(f.baseConfig);
      await expect(accepted).resolves.toMatchObject({ ok: true });
      service.cancelDataDirectoryMigration();
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("does not report idle after a terminal event clears running state but still waits for persistence", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const taskService = f.createLegacyTaskService();
    let receive!: (event: ZCodeStreamEvent) => void | Promise<void>;
    const service = f.createBotsService({
      repo: repo as never,
      credentialService: f.createCredentialService(),
      runStartupBackgroundTasks: false,
      legacyTaskService: {
        ...taskService,
        onDynamicTaskEvent: () => (listener: typeof receive) => {
          receive = listener;
          return { dispose() {} };
        },
      } as typeof taskService,
    });
    try {
      await service.watchAutomationRun({
        target: {
          provider: "webhook",
          botId: "webhook-1",
          providerUserId: "user-1",
          chatType: "private",
        },
        taskId: "task-1",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
      });
      const read = deferred<Awaited<ReturnType<typeof taskService.listTasks>>>();
      const started = deferred<void>();
      vi.mocked(taskService.listTasks).mockImplementationOnce(() => {
        started.resolve();
        return read.promise;
      });
      const terminal = receive({
        type: "task_complete",
        taskId: "task-1",
        traceId: "run-1",
        stopReason: "end_turn",
      });
      await started.promise;
      await repo.writeConfig(disabledConfig);
      await expect(service.reserveForDataDirectoryMigration()).rejects.toThrow(
        "background persistence",
      );
      service.cancelDataDirectoryMigration();
      read.resolve([
        { taskId: "task-1", status: "completed" } as Awaited<
          ReturnType<typeof taskService.listTasks>
        >[number],
      ]);
      await terminal;
      await expect(service.reserveForDataDirectoryMigration()).resolves.toBeUndefined();
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("keeps startup work in the barrier and restores the recovery timer after cancellation", async () => {
    vi.useFakeTimers();
    const refresh = deferred<void>();
    runtime.refresh.mockReturnValueOnce(refresh.promise);
    const repo = f.createMemoryRepo(disabledConfig);
    const readState = vi.spyOn(repo, "readState");
    const service = createService(repo, true);
    try {
      await expect(service.reserveForDataDirectoryMigration()).rejects.toThrow(
        "DATA_DIRECTORY_BUSY",
      );
      service.cancelDataDirectoryMigration();
      refresh.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(readState).toHaveBeenCalled();
      await expect(service.reserveForDataDirectoryMigration()).resolves.toBeUndefined();
      const reads = readState.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(readState).toHaveBeenCalledTimes(reads);
      service.cancelDataDirectoryMigration();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(readState.mock.calls.length).toBeGreaterThan(reads);
    } finally {
      await service.disposeAllAndWait();
      vi.useRealTimers();
    }
  });

  it("propagates provider disposal failure only for migration strict-close", async () => {
    runtime.dispose.mockRejectedValueOnce(new Error("provider close failed"));
    const service = createService();
    await service.reserveForDataDirectoryMigration();
    await expect(service.disposeAllAndWait({ strict: true })).rejects.toThrow(
      "Bot resource close failed",
    );
    runtime.dispose.mockRejectedValueOnce(new Error("normal close failed"));
    await expect(createService().disposeAllAndWait()).resolves.toBeUndefined();
  });
});
