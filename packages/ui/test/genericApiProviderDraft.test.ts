import { describe, expect, it } from "vitest";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import {
  formatProviderHeadersDraft,
  parseProviderHeadersDraft,
  ProviderHeadersDraftError,
  resolvePendingProviderDraftSave,
} from "@/settings/model-provider-section/ProviderDraftSave.js";

const provider: ProviderSettingsFormProvider = {
  providerId: "custom-fixture",
  providerName: "Fixture",
  enabled: true,
  executable: true,
  hasPersonalConfig: false,
  personalConfig: {},
  config: {
    group: "standard-personal",
    access: { type: "api-key", apiKey: "inherited-key" },
    api: {
      type: "openai-responses",
      baseUrl: "https://api.example.test/v1",
      headers: { "X-Inherited": "keep" },
    },
  },
  models: [],
};
const draft = {
  nameValue: "Fixture",
  apiFormat: "openai-responses" as const,
  baseUrlValue: "https://api.example.test/v1",
  apiKeyValue: "inherited-key",
  authMode: "api-key" as const,
  headersValue: formatProviderHeadersDraft(provider.config.api?.headers),
};

describe("Generic API provider drafts", () => {
  it("does not materialize untouched inherited auth or headers", () => {
    expect(resolvePendingProviderDraftSave({ provider, draft, now: () => 0 })).toBeNull();
  });
  it("switches to no authentication without keeping an inherited key", () => {
    const saved = resolvePendingProviderDraftSave({
      provider,
      draft: { ...draft, authMode: "none", apiKeyValue: "" },
      now: () => 0,
    });
    expect(saved?.personalConfig.access).toEqual({
      type: "api-key",
      authMode: "none",
      apiKey: null,
    });
    expect(saved?.personalConfig.api).toBeUndefined();
    expect(saved?.config.api?.headers).toEqual({ "X-Inherited": "keep" });
  });
  it("saves explicit custom headers and clears the old key through the same provider draft", () => {
    const saved = resolvePendingProviderDraftSave({
      provider,
      draft: {
        ...draft,
        authMode: "custom-headers",
        headersValue: '{"Authorization":"Bearer fixture"}',
      },
      now: () => 0,
    });
    expect(saved?.personalConfig.access).toEqual({
      type: "api-key",
      authMode: "custom-headers",
      apiKey: null,
    });
    expect(saved?.personalConfig.api).toEqual({ headers: { Authorization: "Bearer fixture" } });
  });
  it("supports explicitly clearing inherited headers", () => {
    const saved = resolvePendingProviderDraftSave({
      provider,
      draft: { ...draft, headersValue: "" },
      now: () => 0,
    });
    expect(saved?.personalConfig.api).toEqual({ headers: {} });
  });
  it.each(["[1]", "null", '{"X-Test":42}', '{"Authorization":"secret-fixture",'])(
    "blocks invalid JSON without including its text in errors",
    (value) => {
      expect(parseProviderHeadersDraft(value)).toBeNull();
      expect(() =>
        resolvePendingProviderDraftSave({
          provider,
          draft: { ...draft, headersValue: value },
          now: () => 0,
        }),
      ).toThrow(ProviderHeadersDraftError);
      try {
        resolvePendingProviderDraftSave({
          provider,
          draft: { ...draft, headersValue: value },
          now: () => 0,
        });
      } catch (error) {
        expect(String(error)).not.toContain("secret-fixture");
      }
    },
  );
});
