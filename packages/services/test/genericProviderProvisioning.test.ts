import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ModelConfigRules, parsePersonalProviderConfigMap } from "@zcode/provider";
import {
  NodePersonalProviderConfigRepository,
  encodeProviderConfigFile,
} from "@zcode/provider-node";
import { createProviderProvisioningTarget } from "../src/model-provider/providerProvisioningTarget.js";
import { createProviderProvisioningSource } from "../src/model-provider/providerProvisioningSource.js";

const commitFault = vi.hoisted(() => ({ phase: "" }));
vi.mock("@zcode/shared/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zcode/shared/node")>();
  return {
    ...actual,
    atomicWritePrivateTextFile: async (
      ...args: Parameters<typeof actual.atomicWritePrivateTextFile>
    ) => {
      if (args[0].endsWith("receipt.json") && commitFault.phase === "before")
        throw new Error("receipt pre-commit fault");
      await actual.atomicWritePrivateTextFile(...args);
      if (args[0].endsWith("receipt.json") && commitFault.phase === "after")
        throw new Error("receipt post-commit fault");
    },
  };
});

const configuration = (key: string) => ({
  providers: parsePersonalProviderConfigMap({
    providerRules: [
      {
        providerId: "custom",
        config: {
          group: "standard-personal",
          access: { type: "api-key", authMode: "api-key", apiKey: key },
          api: { type: "openai-responses", baseUrl: "https://api.example.test/v1" },
        },
      },
    ],
  }),
  models: ModelConfigRules.empty(),
  providerOrder: ["custom"],
});
async function fixture(run: (value: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const value = await setup();
  try {
    await run(value);
  } finally {
    value.personal.dispose();
    await rm(value.dir, { recursive: true, force: true });
  }
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-generic-provisioning-"));
  const filePath = join(dir, "provider_config.json");
  const stateFilePath = join(dir, "receipt.json");
  const personal = new NodePersonalProviderConfigRepository({ filePath, pollingIntervalMs: false });
  await personal.update(() => configuration("before-key"));
  const cloud = {
    get: vi.fn(async () => {
      throw new Error("Must not read cloud state");
    }),
    update: vi.fn(),
    load: vi.fn(),
    save: vi.fn(),
    delete: vi.fn(),
    refresh: vi.fn(),
  };
  const registry = { refresh: vi.fn(async () => ({ sourceRevisions: { config: "updated" } })) };
  const start = vi.fn(async () => {});
  const target = createProviderProvisioningTarget({
    personalRepository: personal,
    personalConfigFilePath: filePath,
    stateFilePath,
    providerRuntime: { start, registryService: registry } as never,
    settingService: cloud as never,
    credentialService: cloud as never,
    accountProviderSource: cloud as never,
  });
  const envelope = {
    schemaVersion: 3 as const,
    syncId: "fixture-sync",
    personalConfig: encodeProviderConfigFile(configuration("new-key")).config,
  };
  return { dir, filePath, stateFilePath, personal, cloud, registry, start, target, envelope };
}
describe("generic provisioning v3 boundary", () => {
  it.each(["before", "after"])(
    "receipt %s-commit fault preserves the committed outcome",
    async (phase) =>
      fixture(async ({ target, envelope, personal }) => {
        const before = await personal.read();
        commitFault.phase = phase;
        try {
          expect(await target.apply(envelope)).toMatchObject({
            status: phase === "after" ? "applied" : "failed",
            rolledBack: phase !== "after",
          });
          if (phase === "after") {
            expect(await target.apply(envelope)).toMatchObject({ status: "already-applied" });
            expect((await personal.read()).providers.get("custom")?.access?.toJSON()).toMatchObject(
              { apiKey: "new-key" },
            );
          } else expect((await personal.read()).revision).toBe(before.revision);
        } finally {
          commitFault.phase = "";
        }
      }),
  );
  it("converts a known legacy receipt without reapplying an old sync ID", async () =>
    fixture(async ({ target, stateFilePath, envelope, start }) => {
      const result = {
        syncId: "old-sync",
        status: "applied",
        personalProviderCount: 0,
        credentialCount: 1,
        rolledBack: false,
      };
      await writeFile(
        stateFilePath,
        JSON.stringify({ schemaVersion: 1, records: [{ syncId: result.syncId, result }] }),
      );
      expect(await target.apply({ ...envelope, syncId: "old-sync" })).toMatchObject({
        status: "failed",
      });
      expect(start).not.toHaveBeenCalled();
      expect(await target.apply(envelope)).toMatchObject({ status: "applied" });
      expect(JSON.parse(await readFile(stateFilePath, "utf8")).retiredSyncIds).toEqual([
        "old-sync",
      ]);
    }));
  it("Source exports only Personal and never reads credentials or settings", async () =>
    fixture(async ({ personal, cloud, filePath, dir }) => {
      const source = createProviderProvisioningSource({
        personalRepository: personal,
        personalConfigFilePath: filePath,
        credentialFilePath: join(dir, "missing-credentials"),
        settingService: cloud as never,
      });
      const envelope = await source.read("source-sync");
      expect(Object.keys(envelope).sort()).toEqual(["personalConfig", "schemaVersion", "syncId"]);
      expect(envelope.schemaVersion).toBe(3);
      expect(cloud.get).not.toHaveBeenCalled();
    }));
  it("rejects v2 before reading/starting/writing any owner", async () =>
    fixture(async ({ target, cloud, start, personal, envelope }) => {
      const before = await personal.read();
      expect(await target.getCapabilities?.()).toEqual({ supportedSchemaVersions: [3] });
      expect(
        await target.apply({
          ...envelope,
          schemaVersion: 2,
          accountSettings: { providerFamilyDomain: null, providerFamilyConnectionSelections: {} },
          credentials: [],
        }),
      ).toMatchObject({ status: "unsupported", credentialCount: 0 });
      expect(start).not.toHaveBeenCalled();
      expect(cloud.update).not.toHaveBeenCalled();
      expect((await personal.read()).revision).toBe(before.revision);
    }));
  it("commits generic config, binds replay to content and writes no secrets to receipt", async () =>
    fixture(async ({ target, cloud, envelope, stateFilePath }) => {
      expect(await target.apply(envelope)).toMatchObject({ status: "applied", credentialCount: 0 });
      expect(await target.apply(envelope)).toMatchObject({ status: "already-applied" });
      const different = {
        ...envelope,
        personalConfig: encodeProviderConfigFile(configuration("different-key")).config,
      };
      expect(await target.apply(different)).toMatchObject({ status: "failed" });
      const receipt = await readFile(stateFilePath, "utf8");
      expect(receipt).not.toContain("new-key");
      expect(receipt).not.toContain("api.example");
      for (const mock of Object.values(cloud)) expect(mock).not.toHaveBeenCalled();
    }));
  it("rolls back a refresh failure and preserves the preexisting config", async () =>
    fixture(async ({ target, registry, personal, envelope }) => {
      const before = await personal.read();
      registry.refresh.mockRejectedValueOnce(new Error("secret=must-not-return"));
      const result = await target.apply(envelope);
      expect(result).toMatchObject({
        status: "failed",
        rolledBack: true,
        errorCode: "target-refresh-failed",
      });
      expect(JSON.stringify(result)).not.toContain("must-not-return");
      expect((await personal.read()).revision).toBe(before.revision);
    }));
  it("keeps unknown receipt untouched and does not overwrite concurrent config on rollback", async () =>
    fixture(async ({ target, registry, stateFilePath, personal, envelope }) => {
      await writeFile(stateFilePath, "{broken");
      expect(await target.apply(envelope)).toMatchObject({ status: "failed" });
      expect(await readFile(stateFilePath, "utf8")).toBe("{broken");
      await rm(stateFilePath);
      registry.refresh.mockImplementationOnce(async () => {
        await personal.update(() => configuration("concurrent-key"));
        throw new Error("refresh failure");
      });
      expect(await target.apply(envelope)).toMatchObject({
        status: "rollback_failed",
        rolledBack: false,
      });
      expect((await personal.read()).providers.get("custom")?.access?.toJSON()).toMatchObject({
        apiKey: "concurrent-key",
      });
    }));
});
