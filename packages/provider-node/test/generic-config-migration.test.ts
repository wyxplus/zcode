import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeProviderConfigFile,
  encodeProviderConfigFile,
} from "../src/provider-config-file-codec.js";
import { NodePersonalProviderConfigRepository } from "../src/personal-provider-config-repository.js";

const legacy = (headers = {}) => ({
  schemaVersion: 1,
  config: {
    providerConfigRules: {
      providerRules: [
        {
          providerId: "ordinary",
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: "fixture-private-key" },
            api: { type: "anthropic-messages", baseUrl: "https://api.example.test", headers },
            personalModelIds: ["custom"],
          },
        },
      ],
    },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    providerOrder: ["ordinary"],
    defaultModelSelection: {
      providerId: "ordinary",
      modelId: "custom",
      options: { reasoningLevel: "disabled" },
    },
  },
});
describe("Personal generic config v2 migration", () => {
  it("preserves ordinary identity/default/order and explicitly marks key auth", () => {
    const original = legacy();
    const output = encodeProviderConfigFile(decodeProviderConfigFile(original));
    expect(output.schemaVersion).toBe(2);
    expect(output.config.defaultModelSelection).toEqual(original.config.defaultModelSelection);
    expect(output.config.providerOrder).toEqual(["ordinary"]);
    expect(output.config.providerConfigRules.providerRules[0]?.config.access).toEqual({
      type: "api-key",
      apiKey: "fixture-private-key",
      authMode: "api-key",
    });
    expect(original.config.providerConfigRules.providerRules[0]?.config.access).not.toHaveProperty(
      "authMode",
    );
    expect(encodeProviderConfigFile(decodeProviderConfigFile(output))).toEqual(output);
  });
  it("retains legacy SDK/custom authentication exactly without a second key owner", () => {
    const output = encodeProviderConfigFile(
      decodeProviderConfigFile(legacy({ Authorization: "Bearer override" })),
    );
    const config = output.config.providerConfigRules.providerRules[0]?.config;
    expect(config?.access).toEqual({ type: "api-key", authMode: "custom-headers" });
    expect(config?.api?.headers).toEqual({
      Authorization: "Bearer override",
      "x-api-key": "fixture-private-key",
    });
  });
  it("backs up before write, journals only hashes, is reentrant, and does not mark global completion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-generic-migration-"));
    const filePath = join(dir, "provider_config.json");
    const raw = JSON.stringify(legacy());
    const repo = new NodePersonalProviderConfigRepository({ filePath, pollingIntervalMs: false });
    try {
      await writeFile(filePath, raw);
      const first = await repo.read();
      expect(JSON.parse(await readFile(filePath, "utf8")).schemaVersion).toBe(2);
      expect(await readFile(`${filePath}.generic-api-v1.backup.json`, "utf8")).toBe(raw);
      if (process.platform !== "win32")
        expect((await stat(`${filePath}.generic-api-v1.backup.json`)).mode & 0o777).toBe(0o600);
      const journalText = await readFile(`${filePath}.generic-api-migration.json`, "utf8");
      expect(journalText).not.toContain("fixture-private-key");
      expect(journalText).not.toContain("api.example");
      const journal = JSON.parse(journalText);
      expect(journal.stage).toBe("config-complete");
      expect(journal.completedAt).toBeUndefined();
      await writeFile(
        `${filePath}.generic-api-migration.json`,
        JSON.stringify({ ...journal, stage: "config-pending" }),
      );
      expect((await repo.read()).revision).toBe(first.revision);
      expect(
        JSON.parse(await readFile(`${filePath}.generic-api-migration.json`, "utf8")).stage,
      ).toBe("config-complete");
      expect(await readFile(`${filePath}.generic-api-v1.backup.json`, "utf8")).toBe(raw);
    } finally {
      repo.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.each([
    "{broken",
    JSON.stringify({ ...legacy(), schemaVersion: 99 }),
    JSON.stringify({ ...legacy(), unknown: true }),
  ])("keeps unknown/damaged data untouched without a backup", async (raw) => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-generic-invalid-"));
    const filePath = join(dir, "provider_config.json");
    const repo = new NodePersonalProviderConfigRepository({ filePath, pollingIntervalMs: false });
    try {
      await writeFile(filePath, raw);
      await repo.read();
      await expect(repo.update((current) => current)).rejects.toThrow();
      expect(await readFile(filePath, "utf8")).toBe(raw);
      await expect(stat(`${filePath}.generic-api-v1.backup.json`)).rejects.toThrow();
    } finally {
      repo.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
