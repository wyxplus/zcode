import { describe, expect, it, vi } from "vitest";
import type { IServerChannel } from "@zcode/rpc";
import { ServiceCollection } from "../src/collection.js";
import { createServiceDescriptor } from "../src/descriptors.js";
import {
  reserveDataDirectoryMigration,
  cancelDataDirectoryMigration,
  prepareForDataDirectoryMigration,
} from "../src/serviceDataDirectoryMaintenance.js";
import { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";
import { IBotsService } from "../src/bots/bots.js";

describe("data directory RPC admission", () => {
  it("seals every attachment before inspecting in-flight calls", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let writes = 0;
    const services = new ServiceCollection();
    services.register(createServiceDescriptor("test"), {
      async write() {
        writes += 1;
        await pending;
      },
    });
    const channels: IServerChannel[] = [];
    for (let i = 0; i < 2; i += 1) {
      services.exposeOnChannelServer({
        registerChannel: (_name, channel) => channels.push(channel),
      });
    }
    const writing = channels[0]!.call("desktop", "write");
    expect(() => services.beginDataDirectoryMaintenance()).toThrow("DATA_DIRECTORY_BUSY");
    await expect(channels[1]!.call("mobile", "write")).rejects.toThrow(
      "DATA_DIRECTORY_MAINTENANCE",
    );
    finish();
    await writing;
    expect(() => services.beginDataDirectoryMaintenance()).not.toThrow();
    await expect(channels[0]!.call("desktop", "write")).rejects.toThrow(
      "DATA_DIRECTORY_MAINTENANCE",
    );
    expect(writes).toBe(1);
  });

  it("restores admission without closing the Agent when reservation reports busy", async () => {
    const services = new ServiceCollection();
    const channelList: IServerChannel[] = [];
    services.register(createServiceDescriptor("probe"), { read: () => "open" });
    services.register(IZCodeAgentService, {
      async reserveForDataDirectoryMigration() {
        await expect(channelList[0]!.call("mobile", "read")).rejects.toThrow("MAINTENANCE");
        throw new Error("DATA_DIRECTORY_BUSY: accepted command is still queued");
      },
      cancelDataDirectoryMigration: vi.fn(async () => {}),
    } as unknown as IZCodeAgentService);
    services.exposeOnChannelServer({
      registerChannel: (name, channel) => {
        if (name === "probe") channelList.push(channel);
      },
    });
    await expect(reserveDataDirectoryMigration(services)).rejects.toThrow("BUSY");
    await expect(channelList[0]!.call("desktop", "read")).resolves.toBe("open");
  });

  it("refuses an Agent implementation without the maintenance protocol", async () => {
    const services = new ServiceCollection();
    services.register(IZCodeAgentService, {} as IZCodeAgentService);
    await expect(reserveDataDirectoryMigration(services)).rejects.toThrow("UNSUPPORTED");
  });

  it("refuses a pending Bot input before closing an otherwise idle Agent", async () => {
    const services = new ServiceCollection();
    const closeAgent = vi.fn(async () => {});
    services.register(IZCodeAgentService, {
      prepareForDataDirectoryMigration: closeAgent,
      reserveForDataDirectoryMigration: vi.fn(),
      cancelDataDirectoryMigration: vi.fn(),
    } as unknown as IZCodeAgentService);
    services.register(IBotsService, {
      reserveForDataDirectoryMigration: async () => {
        throw new Error("DATA_DIRECTORY_BUSY: Bot attachment preparation");
      },
      cancelDataDirectoryMigration: vi.fn(),
    } as unknown as IBotsService);
    await expect(reserveDataDirectoryMigration(services)).rejects.toThrow("Bot attachment");
    expect(closeAgent).not.toHaveBeenCalled();
  });

  it("reserves without closing, permits cancel, and requires a new reservation before close", async () => {
    const services = new ServiceCollection();
    const closeAgent = vi.fn(async () => {});
    const cancel = vi.fn(async () => {});
    services.register(IZCodeAgentService, {
      prepareForDataDirectoryMigration: closeAgent,
      reserveForDataDirectoryMigration: vi.fn(),
      cancelDataDirectoryMigration: cancel,
    } as unknown as IZCodeAgentService);
    await reserveDataDirectoryMigration(services);
    expect(closeAgent).not.toHaveBeenCalled();
    await cancelDataDirectoryMigration(services);
    expect(cancel).toHaveBeenCalledOnce();
    await expect(prepareForDataDirectoryMigration(services)).rejects.toThrow("NOT_RESERVED");
    await reserveDataDirectoryMigration(services);
    await prepareForDataDirectoryMigration(services);
    expect(closeAgent).toHaveBeenCalledOnce();
    await expect(cancelDataDirectoryMigration(services)).rejects.toThrow("ALREADY_CLOSING");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createReservationFixture() {
  const services = new ServiceCollection();
  const channels: IServerChannel[] = [];
  services.register(createServiceDescriptor("probe"), { read: () => "open" });
  const bot = {
    reserveForDataDirectoryMigration: vi.fn(async () => {}),
    cancelDataDirectoryMigration: vi.fn(async () => {}),
  };
  const agent = {
    reserveForDataDirectoryMigration: vi.fn(async () => {}),
    cancelDataDirectoryMigration: vi.fn(async () => {}),
    prepareForDataDirectoryMigration: vi.fn(async () => {}),
  };
  services.register(IBotsService, bot as unknown as IBotsService);
  services.register(IZCodeAgentService, agent as unknown as IZCodeAgentService);
  services.exposeOnChannelServer({
    registerChannel: (name, channel) => {
      if (name === "probe") channels.push(channel);
    },
  });
  return { services, bot, agent, read: () => channels[0]!.call("desktop", "read") };
}

describe("data directory reservation cancellation ordering", () => {
  it.each(["resolve", "reject"] as const)(
    "cancel restores admission without waiting for a delayed reserve to %s",
    async (outcome) => {
      const f = createReservationFixture();
      const pending = deferred<void>();
      f.bot.reserveForDataDirectoryMigration.mockReturnValueOnce(pending.promise);
      const reserving = reserveDataDirectoryMigration(f.services);
      const rejected = expect(reserving).rejects.toThrow(
        outcome === "resolve" ? "CANCELLED" : "late reserve failed",
      );
      await cancelDataDirectoryMigration(f.services);
      await expect(f.read()).resolves.toBe("open");
      expect(f.agent.reserveForDataDirectoryMigration).not.toHaveBeenCalled();
      // cancel已完成也不能让下一轮与旧owner的异步预留重叠。
      await expect(reserveDataDirectoryMigration(f.services)).rejects.toThrow("BUSY");
      if (outcome === "resolve") pending.resolve();
      else pending.reject(new Error("late reserve failed"));
      await rejected;
      expect(f.bot.cancelDataDirectoryMigration).toHaveBeenCalledOnce();
      expect(f.agent.reserveForDataDirectoryMigration).not.toHaveBeenCalled();
      await expect(prepareForDataDirectoryMigration(f.services)).rejects.toThrow("NOT_RESERVED");
      await reserveDataDirectoryMigration(f.services);
      await expect(f.read()).rejects.toThrow("MAINTENANCE");
      expect(f.bot.reserveForDataDirectoryMigration).toHaveBeenCalledTimes(2);
      expect(f.agent.reserveForDataDirectoryMigration).toHaveBeenCalledOnce();
      await prepareForDataDirectoryMigration(f.services);
      expect(f.agent.prepareForDataDirectoryMigration).toHaveBeenCalledOnce();
      expect(f.bot.cancelDataDirectoryMigration).toHaveBeenCalledOnce();
    },
  );

  it("keeps a cancelled token occupied until both reserve and cancel settle, sharing duplicate cancel", async () => {
    const f = createReservationFixture();
    const reserve = deferred<void>();
    const cancel = deferred<void>();
    f.bot.reserveForDataDirectoryMigration.mockReturnValueOnce(reserve.promise);
    f.bot.cancelDataDirectoryMigration.mockReturnValueOnce(cancel.promise);
    const rejected = expect(reserveDataDirectoryMigration(f.services)).rejects.toThrow("CANCELLED");
    const cancelling = cancelDataDirectoryMigration(f.services);
    const duplicateCancel = cancelDataDirectoryMigration(f.services);
    reserve.resolve();
    await rejected;
    await expect(prepareForDataDirectoryMigration(f.services)).rejects.toThrow("NOT_RESERVED");
    await expect(reserveDataDirectoryMigration(f.services)).rejects.toThrow("BUSY");
    expect(f.bot.cancelDataDirectoryMigration).toHaveBeenCalledOnce();
    cancel.resolve();
    await Promise.all([cancelling, duplicateCancel]);
    await expect(f.read()).resolves.toBe("open");
    await reserveDataDirectoryMigration(f.services);
    await cancelDataDirectoryMigration(f.services);
    expect(f.bot.cancelDataDirectoryMigration).toHaveBeenCalledTimes(2);
  });

  it("retains a failed cancellation for retry instead of allowing a new overlapping reserve", async () => {
    const f = createReservationFixture();
    await reserveDataDirectoryMigration(f.services);
    f.bot.cancelDataDirectoryMigration.mockRejectedValueOnce(new Error("cancel failed"));
    await expect(cancelDataDirectoryMigration(f.services)).rejects.toThrow("CANCEL_FAILED");
    await expect(f.read()).rejects.toThrow("MAINTENANCE");
    await expect(reserveDataDirectoryMigration(f.services)).rejects.toThrow("BUSY");
    await cancelDataDirectoryMigration(f.services);
    await expect(f.read()).resolves.toBe("open");
    await reserveDataDirectoryMigration(f.services);
    await cancelDataDirectoryMigration(f.services);
  });
});
