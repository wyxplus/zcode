import type { ZCodeProcessPrepareDataDirectoryMigrationParams } from "@zcode/shared";
import type { ProtocolRuntimeResources } from "./runtime-resources.js";

/** 协议 admission 的预留只封新输入；所有 owner 预留成功前，已有 app 保持原样。 */
export class ProtocolDataDirectoryMigration {
  private state: "open" | "reserved" | "closing" = "open";
  private closePromise?: Promise<{ ready: true }>;

  constructor(
    private readonly resources: ProtocolRuntimeResources,
    private readonly assertProtocolIdle: () => void,
  ) {}

  get isSealed(): boolean {
    return this.state !== "open";
  }

  async run(
    phase: ZCodeProcessPrepareDataDirectoryMigrationParams["phase"],
  ): Promise<{ ready: true }> {
    if (phase === "cancel") {
      if (this.state === "closing")
        throw new Error("Cannot cancel data migration after close started");
      this.resources.cancelDataDirectoryMigration();
      this.state = "open";
      return { ready: true };
    }
    if (phase === "reserve") {
      if (this.state === "closing") throw new Error("Data migration close already started");
      if (this.state === "reserved") return { ready: true };
      this.state = "reserved";
      try {
        this.assertProtocolIdle();
        this.resources.reserveForDataDirectoryMigration();
      } catch (error) {
        // 任意 owner BUSY 时取消 reservation，原队列和进程继续执行，不能用重启恢复。
        this.state = "open";
        throw error;
      }
      return { ready: true };
    }
    if (this.closePromise) return this.closePromise;
    if (this.state !== "reserved") throw new Error("Data migration must be reserved before close");
    this.assertProtocolIdle();
    this.state = "closing";
    this.closePromise = this.resources
      .prepareForDataDirectoryMigration()
      .then(() => ({ ready: true as const }));
    return this.closePromise;
  }
}
