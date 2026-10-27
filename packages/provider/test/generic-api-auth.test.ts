import { describe, expect, it } from "vitest";
import {
  createRegistryProviderConfig,
  parseProviderConfig,
  serializeRegistryProviderConfig,
} from "../src/index.js";

const protocols = ["anthropic-messages", "openai-chat-completions", "openai-responses"] as const;
const modes = ["api-key", "custom-headers", "none"] as const;

function config(protocol: (typeof protocols)[number], mode: (typeof modes)[number]) {
  return parseProviderConfig({
    group: "standard-personal",
    access: {
      type: "api-key",
      authMode: mode,
      ...(mode === "api-key" ? { apiKey: "fixture-key" } : {}),
    },
    api: {
      type: protocol,
      baseUrl: "http://localhost:8080/proxy",
      ...(mode === "custom-headers" ? { headers: { Authorization: "Bearer fixture-custom" } } : {}),
    },
  });
}

describe("Generic API authentication contract", () => {
  it.each(protocols.flatMap((protocol) => modes.map((mode) => ({ protocol, mode }))))(
    "admits $protocol / $mode and retains the mode across serialization",
    ({ protocol, mode }) => {
      const source = config(protocol, mode);
      const result = createRegistryProviderConfig(source);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected complete generic provider");
      expect(serializeRegistryProviderConfig(result.config).access).toEqual(
        source.access?.toJSON(),
      );
      expect(parseProviderConfig(source.toJSON()).toJSON()).toEqual(source.toJSON());
    },
  );

  it("keeps legacy keys required and rejects missing keys in explicit key mode", () => {
    for (const authMode of [undefined, "api-key"] as const) {
      const source = parseProviderConfig({
        group: "standard-personal",
        access: { type: "api-key", authMode },
        api: { type: "openai-responses", baseUrl: "https://api.example.test/v1" },
      });
      expect(createRegistryProviderConfig(source).ok).toBe(false);
    }
  });

  it("replaces inherited keys when switching away from key authentication", () => {
    const source = config("openai-responses", "api-key");
    const result = source.overlay(
      parseProviderConfig({ access: { type: "api-key", authMode: "none" } }),
    );
    expect(result.access?.toJSON()).not.toHaveProperty("apiKey");
    expect(createRegistryProviderConfig(result).ok).toBe(true);
    expect(source.access?.toJSON()).toHaveProperty("apiKey", "fixture-key");
  });

  it.each([
    { mode: "api-key", headers: { Authorization: "Bearer conflicting" } },
    { mode: "none", headers: { "x-api-key": "conflicting" } },
    { mode: "custom-headers", headers: {} },
    { mode: "none", headers: { "Content-Type": "text/plain" } },
    { mode: "none", headers: { Accept: "text/plain" } },
  ])(
    "rejects conflicting or incomplete explicit header configuration: $mode / $headers",
    ({ mode, headers }) => {
      const source = config("openai-responses", mode as (typeof modes)[number]).overlay(
        parseProviderConfig({ api: { headers } }),
      );
      expect(createRegistryProviderConfig(source).ok).toBe(false);
    },
  );

  it.each(["ftp://api.example.test", "https://user:password@api.example.test/v1"])(
    "does not execute an unsafe endpoint %s",
    (baseUrl) => {
      const source = config("openai-responses", "none").overlay(
        parseProviderConfig({ api: { baseUrl } }),
      );
      expect(createRegistryProviderConfig(source).ok).toBe(false);
    },
  );

  it.each([
    { "bad header": "value" },
    { "X-Test": "one\r\ntwo" },
    { "X-Test": "one\u0000two" },
    { Authorization: "one", authorization: "two" },
  ])("rejects invalid HTTP headers at the configuration boundary", (headers) => {
    expect(() => parseProviderConfig({ api: { headers } })).toThrow();
  });

  it("keeps legacy header overrides readable during the staged cutover", () => {
    const source = parseProviderConfig({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "legacy-key" },
      api: {
        type: "anthropic-messages",
        baseUrl: "https://api.example.test",
        headers: { Authorization: "Bearer legacy-custom" },
      },
    });
    expect(createRegistryProviderConfig(source).ok).toBe(true);
  });
});
