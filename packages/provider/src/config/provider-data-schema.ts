import { z } from "zod";
import { sparseShape } from "@zcode/shared/config-schema";

export const providerApiTypeDataSchema = z.enum([
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
]);
export const providerAuthModeDataSchema = z.enum(["api-key", "custom-headers", "none"]);
export const providerGroupDataSchema = z.enum([
  "standard-personal",
  "zai-family",
  "bigmodel-family",
]);
export const zhipuAccountModeDataSchema = z.enum([
  "start-plan",
  "individual-coding-plan",
  "team-coding-plan",
  "off-peak",
  // 加速卡访问类别；与 zcodeProviderAccountAccessSchema.mode 同值，改动需同步两处。
  "highspeed",
]);
export const providerVisibilityDataSchema = z.enum(["visible", "hidden"]);
export const providerLogoDataSchema = z
  .object({ type: z.literal("builtin"), key: z.string().min(1) })
  .strict();

const nonBlankRequiredString = z.string().refine((value) => value.trim().length > 0, {
  message: "必填配置不能为空",
  params: { configIssueCode: "required-field-missing" },
});

export const apiKeyAccessDataSchema = z
  .object({
    type: z.enum(["api-key", "zhipu-coding-plan-api-key"]),
    authMode: providerAuthModeDataSchema.optional(),
    apiKey: z.string().nullable().optional(),
    apiKeyManagementUrl: z.string().url().nullable().optional(),
  })
  .strict();
export const completeApiKeyAccessDataSchema = apiKeyAccessDataSchema.superRefine(
  (access, context) => {
    const mode = access.authMode ?? "api-key";
    if (mode === "api-key" && !access.apiKey?.trim()) {
      context.addIssue({
        code: "custom",
        path: ["apiKey"],
        message: "必填配置不能为空",
        params: { configIssueCode: "required-field-missing" },
      });
    }
    if (mode !== "api-key" && access.apiKey != null && access.apiKey !== "") {
      context.addIssue({
        code: "custom",
        path: ["apiKey"],
        message: "无鉴权或自定义头模式不能保留 API Key",
      });
    }
    if (access.type === "zhipu-coding-plan-api-key" && mode !== "api-key") {
      context.addIssue({
        code: "custom",
        path: ["authMode"],
        message: "旧 Coding Plan Key 不支持通用鉴权模式",
      });
    }
  },
);

const httpHeadersDataSchema = z
  .record(
    z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "无效 HTTP 头名"),
    z.string().regex(/^[\t\x20-\x7e\x80-\xff]*$/, "HTTP 头值不能包含换行或控制字符"),
  )
  .superRefine((headers, context) => {
    const names = new Set<string>();
    for (const name of Object.keys(headers)) {
      if (names.has(name.toLowerCase()))
        context.addIssue({ code: "custom", path: [name], message: "HTTP 头名不能大小写重复" });
      names.add(name.toLowerCase());
    }
  });

export const completeZhipuAccountAccessDataSchema = z
  .object({
    type: z.literal("zhipu-account"),
    accountType: z.enum(["zai", "bigmodel"]),
    mode: zhipuAccountModeDataSchema,
    entitled: z.boolean(),
  })
  .strict();
export const zhipuAccountAccessDataSchema = z
  .object({
    ...sparseShape(completeZhipuAccountAccessDataSchema.shape),
    type: completeZhipuAccountAccessDataSchema.shape.type,
  })
  .strict();
export const providerAccessDataSchema = z.discriminatedUnion("type", [
  apiKeyAccessDataSchema,
  zhipuAccountAccessDataSchema,
]);
export const completeProviderAccessDataSchema = z.discriminatedUnion("type", [
  completeApiKeyAccessDataSchema,
  completeZhipuAccountAccessDataSchema,
]);

export const completeProviderApiDataSchema = z
  .object({
    type: providerApiTypeDataSchema,
    baseUrl: nonBlankRequiredString.pipe(z.string().url()).pipe(
      z.string().refine((value) => {
        const url = new URL(value);
        return (
          (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
        );
      }, "API 地址必须为 HTTP/HTTPS，且不能内嵌凭据"),
    ),
    headers: httpHeadersDataSchema.readonly().nullable().optional(),
  })
  .strict();
export const providerApiDataSchema = z
  .object({
    ...sparseShape(completeProviderApiDataSchema.shape),
    baseUrl: z.string().url().nullable().optional(),
  })
  .strict();
// Personal 允许暂存编辑中的 endpoint；完整 schema 仍拒绝，且只影响该 Provider 的准入。
export const personalProviderApiDataSchema = providerApiDataSchema.extend({
  baseUrl: z.string().nullable().optional(),
});

const modelIdsDataSchema = z.array(z.string().min(1)).readonly().nullable().optional();
export const providerConfigDataSchema = z
  .object({
    group: providerGroupDataSchema.nullable().optional(),
    logo: providerLogoDataSchema.nullable().optional(),
    access: providerAccessDataSchema.nullable().optional(),
    api: providerApiDataSchema.nullable().optional(),
    builtinModelIds: modelIdsDataSchema,
    personalModelIds: modelIdsDataSchema,
    modelOrder: modelIdsDataSchema,
    visibility: providerVisibilityDataSchema.nullable().optional(),
  })
  .strict();
export const completeProviderConfigDataSchema = providerConfigDataSchema
  .extend({
    group: providerGroupDataSchema,
    access: completeProviderAccessDataSchema,
    api: completeProviderApiDataSchema,
  })
  .superRefine((config, context) => {
    if (config.access.type === "zhipu-account" || !config.access.authMode) return;
    const headers = Object.entries(config.api.headers ?? {});
    if (config.access.authMode === "custom-headers" && headers.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["api", "headers"],
        message: "自定义头模式需要显式 headers",
      });
    }
    for (const [name, value] of headers) {
      const normalized = name.toLowerCase();
      if (
        (normalized === "authorization" || normalized === "x-api-key") &&
        config.access.authMode !== "custom-headers"
      ) {
        context.addIssue({
          code: "custom",
          path: ["api", "headers", name],
          message: "鉴权头只能由自定义头模式配置",
        });
      }
      if (
        (normalized === "content-type" && value.toLowerCase() !== "application/json") ||
        normalized === "accept" ||
        (normalized === "anthropic-version" &&
          (config.api.type !== "anthropic-messages" || value !== "2023-06-01"))
      ) {
        context.addIssue({
          code: "custom",
          path: ["api", "headers", name],
          message: "不能覆盖协议保留头",
        });
      }
    }
  });

export const providerTemplateNameMapDataSchema = z
  .object({
    "zh-CN": z.string().min(1).optional(),
    "en-US": z.string().min(1).optional(),
  })
  .strict();
export const providerTemplateDataSchema = z
  .object({
    templateId: z.string().min(1),
    templateNameMap: providerTemplateNameMapDataSchema,
    config: providerConfigDataSchema,
  })
  .strict();
