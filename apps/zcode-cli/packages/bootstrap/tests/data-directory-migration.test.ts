import { describe, expect, it, vi } from "vitest";
import type { ZCodeApp } from "../src/app/types.js";
import { ProtocolRuntimeResources } from "../src/zcode-protocol/runtime-resources.js";
import { closeSessionResources } from "../src/app/session-facade.js";
import type { Logger } from "@zcode/contracts";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import { ProtocolDataDirectoryMigration } from "../src/zcode-protocol/data-directory-migration.js";

function fakeApp(busy: boolean | (() => boolean), close = vi.fn(async () => {})): ZCodeApp {
  return {
    runtime: { hasResidencyBlockingWork: () => (typeof busy === "function" ? busy() : busy) },
    prepareForDataDirectoryMigration: close,
  } as unknown as ZCodeApp;
}

describe("strict data directory migration shutdown", () => {
  it("can cancel a ready owner when another owner is busy without closing either app", async () => {
    const firstApp = fakeApp(false);
    const busyApp = fakeApp(true);
    const first = new ProtocolRuntimeResources(async () => firstApp);
    const busy = new ProtocolRuntimeResources(async () => busyApp);
    await first.create();
    await busy.create();
    const firstGate = new ProtocolDataDirectoryMigration(first, () => {});
    const busyGate = new ProtocolDataDirectoryMigration(busy, () => {});
    await firstGate.run("reserve");
    await expect(busyGate.run("reserve")).rejects.toThrow("idle");
    await firstGate.run("cancel");
    expect(firstApp.prepareForDataDirectoryMigration).not.toHaveBeenCalled();
    expect(busyApp.prepareForDataDirectoryMigration).not.toHaveBeenCalled();
    expect(() => first.assertServing()).not.toThrow();
    expect(() => busy.assertServing()).not.toThrow();
  });
  it("keeps accepted queued commands and apps live after a busy reservation", async () => {
    const app = fakeApp(false);
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: async () => app,
      cwd: "/workspace",
    });
    const context = server as unknown as {
      context: {
        sessions: Map<string, object>;
        v4Gateway?: {
          hasResidencyBlockingCommands(sessionId: string): boolean;
          hasConversationSubscribers(sessionId: string): boolean;
        };
      };
      runtimeResources: ProtocolRuntimeResources;
    };
    await context.runtimeResources.create();
    context.context.sessions.set("queued", {
      app,
      updatedAt: Date.now(),
      persistence: "immediate",
    });
    context.context.v4Gateway = {
      hasResidencyBlockingCommands: () => true,
      hasConversationSubscribers: () => false,
    };
    expect(
      await server.handleMessage({
        id: "migration",
        method: "process/prepareDataDirectoryMigration",
        params: { phase: "reserve" },
      }),
    ).toMatchObject({ error: { message: expect.stringContaining("active session") } });
    expect(app.prepareForDataDirectoryMigration).not.toHaveBeenCalled();
    expect(context.context.sessions.has("queued")).toBe(true);
    expect(() => context.runtimeResources.assertServing()).not.toThrow();
    expect(
      await server.handleMessage({ id: "next", method: "runtime/capabilities", params: {} }),
    ).toMatchObject({ result: { independentPlanState: true } });
  });
  it("reserves without closing, cancels admission, and only closes after the explicit close phase", async () => {
    const app = fakeApp(false);
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: async () => app,
      cwd: "/workspace",
    });
    await (
      server as unknown as { runtimeResources: ProtocolRuntimeResources }
    ).runtimeResources.create();
    const request = {
      id: "migration",
      method: "process/prepareDataDirectoryMigration",
      params: { phase: "reserve" },
    };
    expect(await server.handleMessage(request)).toMatchObject({
      id: "migration",
      result: { ready: true },
    });
    expect(await server.handleMessage(request)).toMatchObject({ result: { ready: true } });
    expect(app.prepareForDataDirectoryMigration).not.toHaveBeenCalled();
    expect(
      await server.handleMessage({ id: "later", method: "runtime/capabilities", params: {} }),
    ).toMatchObject({ id: "later", error: { message: expect.stringContaining("migration") } });
    expect(await server.handleMessage({ ...request, params: { phase: "cancel" } })).toHaveProperty(
      "result",
    );
    expect(
      await server.handleMessage({ id: "resumed", method: "runtime/capabilities", params: {} }),
    ).toHaveProperty("result");
    expect(await server.handleMessage({ ...request, params: { phase: "close" } })).toMatchObject({
      error: { message: expect.stringContaining("reserved") },
    });
    await server.handleMessage(request);
    expect(await server.handleMessage({ ...request, params: { phase: "close" } })).toHaveProperty(
      "result",
    );
    expect(await server.handleMessage({ ...request, params: { phase: "close" } })).toHaveProperty(
      "result",
    );
    expect(app.prepareForDataDirectoryMigration).toHaveBeenCalledOnce();
    expect(await server.handleMessage({ ...request, params: { phase: "cancel" } })).toMatchObject({
      error: { message: expect.stringContaining("Cannot cancel") },
    });
  });
  it("blocks before closing any app when owned queued/background work exists", async () => {
    const ready = fakeApp(false);
    const busy = fakeApp(true);
    let count = 0;
    const resources = new ProtocolRuntimeResources(async () => (count++ ? busy : ready));
    await resources.create({} as never);
    await resources.create({} as never);
    expect(() => resources.reserveForDataDirectoryMigration()).toThrow("idle");
    expect(ready.prepareForDataDirectoryMigration).not.toHaveBeenCalled();
    expect(() => resources.assertServing()).not.toThrow();
  });
  it("does not acknowledge a failed close and closes each app only once", async () => {
    const close = vi.fn(async () => {
      throw new Error("flush failed");
    });
    const resources = new ProtocolRuntimeResources(async () => fakeApp(false, close));
    await resources.create({} as never);
    resources.reserveForDataDirectoryMigration();
    await expect(resources.prepareForDataDirectoryMigration()).rejects.toThrow("shutdown failed");
    await expect(resources.prepareForDataDirectoryMigration()).rejects.toThrow("shutdown failed");
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => resources.cancelDataDirectoryMigration()).toThrow("Cannot cancel");
  });
  it("rejects reservation during app initialization without closing its accepted late result", async () => {
    const app = fakeApp(false);
    let finish!: (value: ZCodeApp) => void;
    const resources = new ProtocolRuntimeResources(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const creating = resources.create();
    expect(() => resources.reserveForDataDirectoryMigration()).toThrow("initialization");
    finish(app);
    expect(await creating).toBe(app);
    expect(app.prepareForDataDirectoryMigration).not.toHaveBeenCalled();
    expect(() => resources.assertServing()).not.toThrow();
  });
  it("rechecks runtime activity before strict close", async () => {
    let busy = false;
    const app = fakeApp(() => busy);
    const resources = new ProtocolRuntimeResources(async () => app);
    await resources.create();
    resources.reserveForDataDirectoryMigration();
    busy = true;
    await expect(resources.prepareForDataDirectoryMigration()).rejects.toThrow("idle");
    expect(app.prepareForDataDirectoryMigration).not.toHaveBeenCalled();
    expect(() => resources.assertServing()).toThrow();
  });
  it("propagates store/resource failures in strict mode while keeping normal close semantics", async () => {
    const makeInput = () => ({
      beginShutdown: vi.fn(),
      closeBrowserSession: vi.fn(async () => {
        throw new Error("browser flush failed");
      }),
      closeSessionStore: vi.fn(() => {
        throw new Error("database close failed");
      }),
      logger: { warn: vi.fn() } as unknown as Logger,
    });
    await expect(closeSessionResources(makeInput())).resolves.toBeUndefined();
    const input = makeInput();
    await expect(closeSessionResources({ ...input, strict: true })).rejects.toThrow(
      "resource close failed",
    );
    expect(input.closeSessionStore).toHaveBeenCalledOnce();
  });
});
