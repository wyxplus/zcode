import type { ProviderAuthMode } from "@zcode/provider";

/**
 * SDK 会生成自己的鉴权头。无 Key 模式在最终协议边界移除它们，避免环境变量/空 Bearer 泄漏；
 * custom 只恢复配置 owner 显式提供的认证头，不猜测厂商，也不接受另一条动态 Key 写路径。
 */
export function createModelAuthFetch(
  transport: typeof fetch,
  mode: ProviderAuthMode,
  configuredHeaders: Readonly<Record<string, string>> | undefined,
): typeof fetch {
  if (mode === "api-key") return transport;
  return async (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.delete("authorization");
    headers.delete("x-api-key");
    if (mode === "custom-headers") {
      for (const [name, value] of Object.entries(configuredHeaders ?? {})) {
        if (name.toLowerCase() === "authorization" || name.toLowerCase() === "x-api-key")
          headers.set(name, value);
      }
    }
    return transport(input, { ...init, headers });
  };
}
