import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelConfigRules, ProviderConfigMap } from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderProvisioningTarget as createLegacyTarget } from "./fixtures/provisioning-v1/target.js";
import { createProviderProvisioningTarget } from "../src/model-provider/providerProvisioningTarget.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function createEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 3,
    syncId: "sync-1",
    personalConfig: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "custom",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "new-key" },
              api: { type: "openai-chat-completions", baseUrl: "https://example.com/v1" },
              personalModelIds: ["model-a"],
            },
          },
        ],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      providerOrder: ["custom"],
      defaultModelSelection: { providerId: "custom", modelId: "model-a" },
    },
    ...overrides,
  };
}

async function createTarget(
  overrides: {
    legacy?: boolean;
    refresh?: () => Promise<unknown>;
    initialCredentials?: Readonly<Record<string, string>>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "provider-provisioning-target-"));
  const personalConfigFilePath = join(directory, "provider_config.json");
  const personal = new NodePersonalProviderConfigRepository({
    filePath: personalConfigFilePath,
    pollingIntervalMs: false,
  });
  cleanups.push(async () => {
    personal.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await personal.update(() => ({
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
    providerOrder: [],
    defaultModelSelection: { providerId: "old", modelId: "old-model" },
  }));
  const replacePersonalConfig = vi.spyOn(personal, "update");
  let currentSettings = {
    providerFamilyDomain: "bigmodel" as const,
    providerFamilyConnectionSelections: {},
  };
  const credentialValues = new Map<string, string | null>([
    ["oauth:zai:access_token", "old-token"],
    ...Object.entries(overrides.initialCredentials ?? {}),
  ]);
  const settingUpdate = vi.fn(async (patch: unknown) => {
    currentSettings = { ...currentSettings, ...(patch as Partial<typeof currentSettings>) };
  });
  const credentialSave = vi.fn(async (key: string, value: string) => {
    credentialValues.set(key, value);
  });
  const credentialService = {
    load: vi.fn(async (key: string) => credentialValues.get(key) ?? null),
    save: credentialSave,
    delete: vi.fn(async (key: string) => {
      credentialValues.set(key, null);
    }),
  };
  const target = (overrides.legacy ? createLegacyTarget : createProviderProvisioningTarget)({
    providerRuntime: {
      start: vi.fn(async () => undefined),
      registryService: {
        refresh: vi.fn(async () => {
          await overrides.refresh?.();
          return { sourceRevisions: { config: "target-revision" } };
        }),
        validateSelection: vi.fn(() => ({ ok: true })),
      },
    } as never,
    personalRepository: personal,
    accountProviderSource: { refresh: vi.fn(async () => undefined) } as never,
    credentialService,
    listProvisioningCredentialKeys: async () => [...credentialValues.keys()],
    settingService: { get: vi.fn(async () => currentSettings), update: settingUpdate } as never,
    personalConfigFilePath,
    stateFilePath: join(directory, "provisioning.json"),
  });
  return {
    target,
    personal,
    replacePersonalConfig,
    settingUpdate,
    credentialSave,
    credentialLoad: credentialService.load,
    credentialDelete: credentialService.delete,
    credentialValues,
    personalConfigFilePath,
    directory,
  };
}

describe("Provider Provisioning Target v3", () => {
  it("writes only Personal, refreshes Registry and is idempotent", async () => {
    const f = await createTarget();
    expect(await f.target.apply(createEnvelope() as never)).toMatchObject({
      status: "applied",
      personalProviderCount: 1,
      credentialCount: 0,
      rolledBack: false,
    });
    expect(f.settingUpdate).not.toHaveBeenCalled();
    expect(f.credentialSave).not.toHaveBeenCalled();
    expect(f.credentialDelete).not.toHaveBeenCalled();
    expect(f.replacePersonalConfig).toHaveBeenCalledTimes(1);
    expect((await f.personal.read()).defaultModelSelection).toEqual({
      providerId: "custom",
      modelId: "model-a",
    });
    expect(await f.target.apply(createEnvelope() as never)).toMatchObject({
      status: "already-applied",
    });
    expect(f.replacePersonalConfig).toHaveBeenCalledTimes(1);
  });
  it("preserves receipt history so stale retries cannot restore an older config", async () => {
    const f = await createTarget();
    expect(await f.target.apply(createEnvelope({ syncId: "sync-a" }) as never)).toMatchObject({
      status: "applied",
    });
    expect(await f.target.apply(createEnvelope({ syncId: "sync-b" }) as never)).toMatchObject({
      status: "applied",
    });
    expect(await f.target.apply(createEnvelope({ syncId: "sync-a" }) as never)).toMatchObject({
      status: "already-applied",
    });
    expect(f.replacePersonalConfig).toHaveBeenCalledTimes(2);
  });
  it("empty Personal clears the mirror and configured default in one update", async () => {
    const f = await createTarget();
    const input = createEnvelope({
      personalConfig: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        providerOrder: [],
      },
    });
    expect(await f.target.apply(input as never)).toMatchObject({
      status: "applied",
      personalProviderCount: 0,
    });
    expect((await f.personal.read()).defaultModelSelection).toBeUndefined();
    expect(f.credentialValues.get("oauth:zai:access_token")).toBe("old-token");
  });
  it.each([0, 1, 2, 99])(
    "rejects legacy/unknown version %s before owner writes",
    async (schemaVersion) => {
      const f = await createTarget();
      expect(await f.target.apply(createEnvelope({ schemaVersion }) as never)).toMatchObject({
        status: "unsupported",
      });
      expect(f.settingUpdate).not.toHaveBeenCalled();
      expect(f.credentialSave).not.toHaveBeenCalled();
      expect(f.replacePersonalConfig).not.toHaveBeenCalled();
    },
  );
  it("legacy Target rejects v3 before it can delete shared credentials", async () => {
    const f = await createTarget({
      legacy: true,
      initialCredentials: { "account-provider:zai:api-key": "keep-key" },
    });
    await expect(f.target.apply(createEnvelope() as never)).rejects.toThrow();
    expect(f.settingUpdate).not.toHaveBeenCalled();
    expect(f.credentialDelete).not.toHaveBeenCalled();
    expect(f.replacePersonalConfig).not.toHaveBeenCalled();
    expect(f.credentialValues.get("account-provider:zai:api-key")).toBe("keep-key");
  });
});
