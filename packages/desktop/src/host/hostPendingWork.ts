/** Host 回调发起的持久化工作不经过 RPC/parentPort handler，必须独立纳入搬盘停写屏障。 */
export class HostPendingWork {
  private count = 0;

  async track<T>(run: () => Promise<T>): Promise<T> {
    // 必须在调用 run 前登记，避免 run 的同步部分触发另一个维护请求时看见假 idle。
    this.count += 1;
    try {
      return await run();
    } finally {
      this.count -= 1;
    }
  }

  assertIdle(): void {
    if (this.count > 0)
      throw new Error("DATA_DIRECTORY_BUSY: Host background persistence is still pending");
  }
}
