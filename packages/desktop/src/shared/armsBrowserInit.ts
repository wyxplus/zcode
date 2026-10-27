import type { ZCodeRuntimeEnv } from "@zcode/shared";

/** D01：保留启动调用合同，但不初始化云 SDK、桥接重试或 load collector。 */
export function initArmsBrowserRumOnce(_runtimeEnv: ZCodeRuntimeEnv): boolean {
  return false;
}

export function scheduleArmsBrowserRumInit(_runtimeEnv: ZCodeRuntimeEnv, _maxAttempts = 50): void {
  // 云性能/崩溃上报默认关闭，本轮没有 opt-in。
}
