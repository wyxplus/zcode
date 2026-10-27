import { logger } from "./logger.js";
import { initializeCrashCapture, type CrashCapturePaths } from "./desktopCrashCapture.js";

// 须在 appARMSBootstrap 之前完成：先由 desktopEarlyDataBaseDirBootstrap 注入 dataBaseDir，再配置 crashDumps。
// D01：云 crash reporter 已退出，保留仅本地 dump，明确禁止远端上传。
export const crashCapturePaths: CrashCapturePaths = initializeCrashCapture(logger, false);
