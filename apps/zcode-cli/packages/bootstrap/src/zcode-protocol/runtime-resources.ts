import type { ZCodeApp } from "../app/types.js";
import type { ZCodeProtocolAgentDependencies } from "./server-types.js";

/** 持有 app 资源而非业务 session；临时 workspace app、尚未登记的 app 也归此 owner。 */
export class ProtocolRuntimeResources {
  private stopping = false;
  private readonly apps = new Set<ZCodeApp>();
  private closePromise?: Promise<void>;
  private migrationPromise?: Promise<void>;
  private migrationReserved = false;
  private creatingCount = 0;

  constructor(private readonly factory: ZCodeProtocolAgentDependencies["createZCodeApp"]) {}

  readonly create: ZCodeProtocolAgentDependencies["createZCodeApp"] = async (options) => {
    this.assertServing();
    this.creatingCount += 1;
    let app: ZCodeApp;
    try {
      app = await this.factory(options);
    } finally {
      this.creatingCount -= 1;
    }
    const originalClose = app.close?.bind(app);
    let closing: Promise<void> | undefined;
    app.close = () => {
      closing ??= Promise.resolve().then(async () => {
        try {
          await originalClose?.();
        } finally {
          this.apps.delete(app);
        }
      });
      return closing;
    };
    this.apps.add(app);
    if (this.stopping) {
      // create 在 EOF 前开始、EOF 后返回时不能重新成为可用 session，也不能遗失资源。
      await this.stopApp(app);
      this.assertServing();
    }
    return app;
  };

  assertServing(): void {
    if (this.stopping) throw new Error("ZCode Protocol runtime is stopping");
    if (this.migrationReserved)
      throw new Error("ZCode Protocol runtime is reserved for data migration");
  }

  reserveForDataDirectoryMigration(): void {
    if (this.stopping || this.migrationPromise)
      throw new Error("Data migration resources are already closing");
    this.migrationReserved = true;
    try {
      this.assertMigrationIdle();
    } catch (error) {
      // BUSY 只拒绝本次迁移，不能关闭或遗失已经接受的命令。
      this.migrationReserved = false;
      throw error;
    }
  }

  cancelDataDirectoryMigration(): void {
    if (this.stopping || this.migrationPromise)
      throw new Error("Cannot cancel data migration after resource close started");
    this.migrationReserved = false;
  }

  private assertMigrationIdle(): void {
    if (this.creatingCount > 0) throw new Error("Data migration requires idle app initialization");
    for (const app of this.apps) {
      if (!app.prepareForDataDirectoryMigration || app.runtime.hasResidencyBlockingWork()) {
        throw new Error("Data migration requires idle sessions and strict resource close support");
      }
    }
  }

  prepareForDataDirectoryMigration(): Promise<void> {
    if (this.migrationPromise) return this.migrationPromise;
    if (!this.migrationReserved)
      return Promise.reject(new Error("Data migration must be reserved before close"));
    this.stopping = true;
    this.migrationPromise = Promise.resolve().then(async () => {
      this.assertMigrationIdle();
      const outcomes = await Promise.allSettled(
        [...this.apps].map(async (app) => {
          await app.prepareForDataDirectoryMigration!();
          this.apps.delete(app);
        }),
      );
      const failures = outcomes.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) throw new AggregateError(failures, "Data migration shutdown failed");
    });
    return this.migrationPromise;
  }

  close(): Promise<void> {
    this.stopping = true;
    this.closePromise ??= Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...this.apps].map((app) => this.stopApp(app)));
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "Protocol apps shutdown failed");
    });
    return this.closePromise;
  }

  private async stopApp(app: ZCodeApp): Promise<void> {
    try {
      app.runtime.beginShutdown();
      app.runtime.stopActiveForegroundExecution?.({ reason: "Protocol runtime stopping" });
    } finally {
      await app.close?.();
    }
  }
}
