import { describe, expect, it, vi } from "vitest";
import { createFeishuChannelRuntime } from "../src/bots/feishuChannelRuntime.js";
import * as f from "./botsService.fixtures.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function createRuntime(
  options: {
    close?: () => void;
    release?: () => Promise<void>;
    initialize?: () => Promise<void>;
  } = {},
) {
  const startWebSocket = vi.fn(async () => ({ close: options.close ?? vi.fn() }));
  const runtime = createFeishuChannelRuntime({
    credentialService: f.createCredentialService({ "feishu-secret": "secret" }),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    statusSink: { getRuntimeStatus: vi.fn(), setRuntimeStatus: vi.fn() },
    ensureBotStorageMigrated: options.initialize ?? (async () => undefined),
    readConfig: async () => f.feishuConfig,
    summarizeCallbackPayload: () => "",
    processProviderCallback: async () => ({ ok: true, replies: [] }),
    acquireWebSocketLock: async () => ({ release: options.release ?? (async () => undefined) }),
    startWebSocket,
  });
  return { runtime, startWebSocket };
}

describe("Bot runtime strict migration close", () => {
  it.each(["socket", "lock"])(
    "rejects a failed %s close even though normal shutdown tolerates it",
    async (kind) => {
      const error = new Error(`${kind} close failed`);
      const options =
        kind === "socket"
          ? {
              close: () => {
                throw error;
              },
            }
          : {
              release: async () => {
                throw error;
              },
            };
      const strict = createRuntime(options);
      await strict.runtime.refresh();
      await vi.waitFor(() => expect(strict.startWebSocket).toHaveBeenCalledOnce());
      await expect(strict.runtime.dispose({ strict: true })).rejects.toThrow(
        "Bot provider resource close failed",
      );
      const normal = createRuntime(options);
      await normal.runtime.refresh();
      await vi.waitFor(() => expect(normal.startWebSocket).toHaveBeenCalledOnce());
      await expect(normal.runtime.dispose()).resolves.toBeUndefined();
    },
  );

  it("waits for a detached refresh to settle and prevents it from opening a late socket", async () => {
    const gate = deferred();
    const entered = deferred();
    const f = createRuntime({
      initialize: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    const refreshing = f.runtime.refresh();
    await entered.promise;
    let finished = false;
    const closing = f.runtime.dispose({ strict: true }).then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    gate.resolve();
    await Promise.all([refreshing, closing]);
    expect(finished).toBe(true);
    expect(f.startWebSocket).not.toHaveBeenCalled();
  });
});
