import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { ZCODE_AGENT_LIFECYCLE_LOG_MARKER } from "@zcode/shared/process-diagnostic";
import { ZCODE_VERSION, mapZCodeEnvToArmsRumEnv } from "@zcode/shared";
import { ARMS_BROWSER_COLLECTORS, parseArmsViewName } from "../shared/armsRumShared.js";
import { redactArmsEventBatch } from "./armsEventRedaction.js";
import { ingestArmsApiEventsFromBatch } from "./desktopNetworkTelemetry.js";
import { desktopRuntimeEnv, runtimeApplicationName } from "./desktopRuntimeEnv.js";
import { summarizeLongTaskAttribution } from "./longTaskAttributionSummary.js";
import { logger } from "./logger.js";

// LoAF 长任务事件的 snapshots(SDK 已采集的 top-5 attribution)默认不落 SLS，此处补写进
// event.properties，使归因摘要(top 耗时/占比/invokerType)可查询。不上报原始脚本名/URL。
function enrichLongTaskAttribution(events: Array<Record<string, unknown>>): void {
  for (const event of events) {
    if (event.event_type !== "longTask") {
      continue;
    }
    const summary = summarizeLongTaskAttribution(event.snapshots, event.duration);
    if (!summary) {
      continue;
    }
    const existingProps =
      event.properties && typeof event.properties === "object"
        ? (event.properties as Record<string, unknown>)
        : {};
    event.properties = { ...existingProps, ...summary };
  }
}

function isCrashReporterEvent(event: Record<string, unknown>): boolean {
  return (
    event.event_type === "exception" && event.type === "crash" && event.source === "crashReporter"
  );
}

function normalizeExecutableName(value: unknown): string {
  return typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/\.exe$/i, "")
    : "";
}

function hasProductExecutable(
  event: Record<string, unknown>,
  applicationName: string,
  runtimeExecutableName?: string,
): boolean {
  // 修复原因：app name 不等于所有运行形态的真实二进制名；开发态使用 Electron，
  // Linux Preview 使用 zcode-preview。两者都必须精确匹配，不能放宽成前缀以免混入 helper dump。
  const expectedNames = new Set(
    [applicationName, runtimeExecutableName].map(normalizeExecutableName).filter(Boolean),
  );
  if (expectedNames.size === 0 || !Array.isArray(event.binary_images)) {
    return false;
  }
  return event.binary_images.some((image) => {
    if (!image || typeof image !== "object") {
      return false;
    }
    return expectedNames.has(normalizeExecutableName((image as Record<string, unknown>).name));
  });
}

type NativeDumpProcessRole = "main" | "renderer" | "utility" | "gpu" | "host" | "agent" | "unknown";

const nativeDumpProcessRoleAliases: Record<string, NativeDumpProcessRole> = {
  main: "main",
  browser: "main",
  main_process: "main",
  renderer: "renderer",
  utility: "utility",
  utility_host: "utility",
  gpu: "gpu",
  host: "host",
  agent: "agent",
};

function readNativeDumpProcessRole(event: Record<string, unknown>): NativeDumpProcessRole {
  const metadata =
    event.meta && typeof event.meta === "object"
      ? (event.meta as Record<string, unknown>)
      : undefined;
  // 修复原因：通用 process_role 可能由事件属性或中间件注入，并不证明来自 Crashpad dump。
  // 只信任依赖补丁从结构化 annotation RVA 提取并写入的 meta.process_type，避免 helper
  // dump 被非结构化 main 标记提升为 app_native_process，污染 Native Crash / Crash-Free。
  const processType = metadata?.process_type;
  if (typeof processType === "string") {
    return nativeDumpProcessRoleAliases[processType.trim().toLowerCase()] ?? "unknown";
  }
  return "unknown";
}

export function filterAndEnrichNativeCrashEvents(
  events: Array<Record<string, unknown>>,
  applicationName: string,
  runtimeExecutableName?: string,
): Array<Record<string, unknown>> {
  return events.filter((event) => {
    if (!isCrashReporterEvent(event)) {
      return true;
    }
    if (!hasProductExecutable(event, applicationName, runtimeExecutableName)) {
      return false;
    }
    const existingProperties =
      event.properties && typeof event.properties === "object"
        ? (event.properties as Record<string, unknown>)
        : {};
    const nativeDumpProcessRole = readNativeDumpProcessRole(event);
    // 根因：binary_images 只能证明 dump 来自产品二进制，不能区分 Linux/Windows 上
    // 共用同一 executable 的主进程、renderer、utility 或 host。未知角色继续保留原始
    // crashReporter 事件，但不得进入 app_native_process，否则会把 helper crash loop
    // 当成应用 native crash 并拉低 Crash-Free。只有明确标记为 main 的 dump 才进入产品 KPI。
    event.properties = {
      ...existingProperties,
      telemetry_schema_version: "2",
      // Bugfix: SDK 重试可能让同一事件再次经过 beforeReport，必须保留事故 ID 才能去重。
      crash_id:
        typeof existingProperties.crash_id === "string"
          ? existingProperties.crash_id
          : randomUUID(),
      crash_scope:
        nativeDumpProcessRole === "main" ? "app_native_process" : "native_dump_unattributed",
      crash_cause: "native_crash",
      crash_source: "crash_reporter_dump",
      native_dump_process_role: nativeDumpProcessRole,
    };
    return true;
  });
}

// Bugfix: 产品后端可使用 production，但源码启动的 Desktop 仍是本地开发运行态；
// ARMS 环境必须优先按运行形态标记为 local，避免开发数据污染 prod。
const armsRumEnv = mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv);

// 仅保留既有事件脱敏/归因的纯投影供本地验证，不启动 SDK 或绑定设备身份。
const armsDeviceMid = "";

export function buildDisabledArmsConfiguration() {
  return {
    enable: false,
    version: ZCODE_VERSION,
    endpoint: "",
    env: armsRumEnv,
    // D01：不再注入 Browser SDK。
    autoInject: false,
    browserCollectors: { ...ARMS_BROWSER_COLLECTORS },
    app: {
      name: runtimeApplicationName,
      version: ZCODE_VERSION,
      env: armsRumEnv,
      type: "electron",
      framework: "react",
    },
    user: {
      name: armsDeviceMid,
    },
    // 会话采样：必须为 1，否则 ARMS 默认 PV/perf/webvitals 等整会话事件会被丢弃（开发 0.1 时约 90% 看不到页面性能）
    sessionConfig: {
      sampleRate: 1,
    },
    // Electron 桌面为单页 file:// / dev-server 整页加载，无 History 路由；false 才能走 SDK 默认「完整页面加载」perf 采集
    spaMode: false,
    parseViewName: parseArmsViewName,
    collectors: {
      jsError: true,
      consoleError: true,
      crash: true,
      application: true,
      api: true,
      rpc: true,
    },
    // 主进程 collectors：Electron 侧；renderer 侧见 browserCollectors + autoInject
    // SDK tracing.sample 取值 0–100（百分比）；0.1 表示 0.1% 采样，几乎不会命中
    tracing: {
      enable: true,
      sample: armsRumEnv === "prod" ? 0.1 : 1,
    },
    // HTTP 全链路耗时来自 ARMS api 批次；生产/本地运行均 ingest，本地运行额外打印批次摘要
    beforeReport: (payload: { events?: Array<Record<string, unknown>> }) => {
      // Bugfix: crash collector 会扫描共享 dump 目录，外部后代进程的 dump 也可能混入。
      // 只保留包含当前产品可执行文件的原生 crash；过滤仅遍历现有批次元数据，不新增 IO。
      const events = filterAndEnrichNativeCrashEvents(
        // 已有结构化生命周期上报的本地 error 日志不再作为 console JS 异常重复采集。
        // 只按显式标记过滤包装事件，保留真正的 uncaughtException 和其他 console.error。
        (payload?.events ?? []).filter(
          (event) =>
            !(
              event.event_type === "exception" &&
              event.type === "error" &&
              event.source === "console.error" &&
              typeof event.message === "string" &&
              event.message.includes(ZCODE_AGENT_LIFECYCLE_LOG_MARKER)
            ),
        ),
        runtimeApplicationName,
        basename(process.execPath),
      );
      payload.events = events;
      ingestArmsApiEventsFromBatch(events);
      enrichLongTaskAttribution(events);
      // 隐私收口必须排在 ingest 与归因摘要之后：网络聚合沿用自己的 interface 归一规则，
      // longTask 摘要需要原始 snapshots；只有最终离开本机的副本才做脱敏。
      redactArmsEventBatch(events);
      if (desktopRuntimeEnv === "development") {
        const perfEvents = events.filter(
          (event) => String(event.type ?? "").toLowerCase() === "perf",
        );
        const summary = events
          .map((event) => {
            const eventType = String(event.event_type ?? "?");
            const subType = String(event.type ?? "");
            const name = String(event.name ?? "");
            if (subType === "perf") {
              return `${eventType}:perf`;
            }
            return `${eventType}:${name || subType || "?"}`;
          })
          .join(", ");
        logger.info(
          `[arms] beforeReport batch=${events.length} perf=${perfEvents.length}${summary ? ` [${summary}]` : ""}`,
        );
      }
      return payload;
    },
  };
}

// D01：无账号版不启动云 RUM 或 crash reporter，Main 仍可等待同一启动屏障。
export const armsInitPromise = Promise.resolve();
