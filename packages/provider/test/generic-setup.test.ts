import { describe, expect, it, vi } from "vitest";
import {
  ModelConfigRules,
  ProviderConfigMap,
  ProviderConfigService,
  parseModelConfig,
  parseProviderConfig,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
} from "../src/index.js";

const setup = {
  setupId: "75e3f8de-e628-4e13-86bc-5098f31cf979",
  providerName: "My API",
  modelId: "arbitrary-model",
  providerConfig: parseProviderConfig({
    access: { type: "api-key", authMode: "none" },
    api: { type: "openai-responses", baseUrl: "http://localhost:8080/v1" },
  }),
  modelConfig: parseModelConfig({
    enabled: true,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 16000,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: { values: ["disabled"], map: "{}" },
      maxOutputTokens: { max: 4000, map: "{}" },
    },
  }),
};

function owner() {
  let snapshot: ProviderConfigLayerSnapshot = {
    revision: "1",
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
    providerOrder: [],
  };
  const update = vi.fn(
    async (transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate) => {
      const next = transform(snapshot);
      snapshot = { ...next, revision: String(Number(snapshot.revision) + 1) };
      return snapshot;
    },
  );
  const source = { read: async () => snapshot, onDidChange: () => () => {} };
  const empty = { ...snapshot };
  const service = new ProviderConfigService({
    personalRepository: { ...source, update },
    zcodeBuiltinSource: { ...source, read: async () => empty },
  });
  return { service, update, read: () => snapshot };
}

describe("generic setup atomic owner", () => {
  it("writes source, model and full default in one transaction and replays without another source", async () => {
    const { service, update, read } = owner();
    const first = await service.saveGenericSetup(setup);
    expect(update).toHaveBeenCalledTimes(1);
    expect(read().providers.keys().length).toBe(1);
    expect(read().defaultModelSelection).toEqual({
      providerId: first.providerId,
      modelId: setup.modelId,
      options: { reasoningLevel: "disabled" },
    });
    expect(read().models.getExactRule(first.providerId, setup.modelId)).toBeDefined();
    expect(await service.saveGenericSetup(setup)).toEqual(first);
    expect(read().providers.keys().length).toBe(1);
    await expect(service.saveGenericSetup({ ...setup, modelId: "changed" })).rejects.toThrow(
      /conflict/,
    );
    expect(read().providers.keys().length).toBe(1);
  });

  it("rejects incomplete provider/model before any write", async () => {
    const { service, update, read } = owner();
    await expect(
      service.saveGenericSetup({
        ...setup,
        providerConfig: parseProviderConfig({ access: { type: "api-key" } }),
      }),
    ).rejects.toThrow();
    await expect(
      service.saveGenericSetup({ ...setup, modelConfig: parseModelConfig({ enabled: true }) }),
    ).rejects.toThrow();
    await expect(service.saveGenericSetup({ ...setup, setupId: "unsafe-id" })).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
    expect(read().defaultModelSelection).toBeUndefined();
  });

  it("rejects a stale default command within the Personal transaction", async () => {
    const { service, read } = owner();
    const { providerId } = await service.saveGenericSetup(setup);
    const before = read();
    await expect(
      service.saveConfiguredDefault(
        { providerId, modelId: setup.modelId, options: { reasoningLevel: "disabled" } },
        {
          providerId,
          personalRevision: "outdated",
          inheritedModelIds: [],
          assertCurrent: () => {},
        },
      ),
    ).rejects.toThrow(/revision conflict/);
    expect(read()).toBe(before);
  });
});
