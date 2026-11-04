import { ProxyChannel, type IChannelServer } from "@zcode/rpc";
import type { ServiceDescriptor } from "./descriptors.js";

/**
 * ServiceCollection — 服务注册中心
 *
 * 服务端用来注册服务实例，并自动暴露到 ChannelServer。
 */
export class ServiceCollection {
  private readonly _services = new Map<string, unknown>();
  private maintenance = false;
  private activeCalls = 0;

  /** 本机搬盘先封闭 admission，再检查在途调用；不能用 idle 投影替代写屏障。 */
  beginDataDirectoryMaintenance(): void {
    this.maintenance = true;
    if (this.activeCalls > 0) {
      throw new Error("DATA_DIRECTORY_BUSY: service requests are still in flight");
    }
  }

  /** reserve 失败只恢复入口；已经接收的调用继续完成，不能以重启代替取消维护。 */
  cancelDataDirectoryMaintenance(): void {
    this.maintenance = false;
  }

  register<T>(descriptor: ServiceDescriptor<T>, instance: T): this {
    this._services.set(descriptor.channelName, instance);
    return this;
  }

  get<T>(descriptor: ServiceDescriptor<T>): T {
    const instance = this._services.get(descriptor.channelName);
    if (!instance) {
      throw new Error(`Service not registered: ${descriptor.channelName}`);
    }
    return instance as T;
  }

  getOptional<T>(descriptor: ServiceDescriptor<T>): T | undefined {
    return this._services.get(descriptor.channelName) as T | undefined;
  }

  /** 将所有已注册的服务自动暴露为 channel */
  exposeOnChannelServer(
    server: IChannelServer,
    overrides: ReadonlyMap<string, unknown> = new Map(),
  ): void {
    for (const [channelName, instance] of this._services) {
      const exposed = overrides.get(channelName) ?? instance;
      const channel = ProxyChannel.fromService<string>(exposed as Record<string, unknown>);
      server.registerChannel(channelName, {
        call: async (ctx, command, arg, cancellationToken) => {
          if (this.maintenance) throw new Error("DATA_DIRECTORY_MAINTENANCE");
          this.activeCalls += 1;
          try {
            return await channel.call(ctx, command, arg, cancellationToken);
          } finally {
            this.activeCalls -= 1;
          }
        },
        listen: (ctx, event, arg) => {
          if (this.maintenance) throw new Error("DATA_DIRECTORY_MAINTENANCE");
          return channel.listen(ctx, event, arg);
        },
      });
    }
  }
}
