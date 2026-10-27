import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { type PersonalProviderConfigRepository } from "@zcode/provider";
import { decodeProviderConfigFile, encodeProviderConfigFile } from "@zcode/provider-node";
import {
  genericProviderProvisioningEnvelopeSchema,
  providerProvisioningResultSchema,
  type ProviderProvisioningEnvelope,
  type ProviderProvisioningResult,
  type ProviderProvisioningErrorCode,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { ISettingService } from "../setting/setting.js";
import type { ProviderRuntime } from "./providerRuntime.js";
import type { AccountProviderService } from "@zcode/provider";
import type { IProviderProvisioningTargetService } from "./providerProvisioning.js";
import { readProvisionablePersonalConfig } from "./providerProvisioningSource.js";

export interface ProviderProvisioningTargetOptions {
  readonly providerRuntime: ProviderRuntime;
  readonly personalRepository: PersonalProviderConfigRepository;
  readonly personalConfigFilePath: string;
  readonly stateFilePath: string;
  // 旧 DI 暂保留形状直到 S5 收口；v3 不访问这些 owner。
  readonly accountProviderSource?: AccountProviderService;
  readonly credentialService?: ICredentialService;
  readonly settingService?: ISettingService;
  readonly listProvisioningCredentialKeys?: () => Promise<readonly string[]>;
}

const receiptSchema = z
  .object({
    schemaVersion: z.literal(2),
    retiredSyncIds: z.array(z.string().min(1)).optional(),
    records: z.array(
      z
        .object({
          syncId: z.string().min(1),
          contentHash: z.string().regex(/^[a-f0-9]{64}$/),
          result: providerProvisioningResultSchema,
        })
        .strict(),
    ),
  })
  .strict();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** v3 只同步配置；旧信封在任何 runtime/owner 操作前被拒绝。 */
export function createProviderProvisioningTarget(
  options: ProviderProvisioningTargetOptions,
): IProviderProvisioningTargetService {
  return {
    getCapabilities: async () => ({ supportedSchemaVersions: [3] }),
    async apply(input: ProviderProvisioningEnvelope): Promise<ProviderProvisioningResult> {
      if (input.schemaVersion !== 3)
        return {
          syncId: input.syncId,
          status: "unsupported",
          personalProviderCount: 0,
          credentialCount: 0,
          rolledBack: false,
          errorCode: "capability-unavailable",
        };
      let errorCode: ProviderProvisioningErrorCode = "target-write-failed";
      try {
        const envelope = genericProviderProvisioningEnvelopeSchema.parse(input);
        const incoming = decodeProviderConfigFile({
          schemaVersion: 2,
          config: envelope.personalConfig,
        });
        if (
          incoming.providers
            .rules()
            .some(
              (rule) =>
                rule.providerId.startsWith("account:") ||
                rule.config.access?.type === "zhipu-account",
            )
        )
          throw new Error("Retired provider cannot be provisioned");
        const incomingCanonical = encodeProviderConfigFile(incoming);
        const contentHash = hash(incomingCanonical);
        return await withFileLock(options.stateFilePath, async () => {
          const receipts = await readReceipts(options.stateFilePath);
          if (receipts.retiredSyncIds?.includes(envelope.syncId))
            throw new Error("Retired provisioning replay");
          const previous = receipts.records.find((record) => record.syncId === envelope.syncId);
          if (previous) {
            if (previous.contentHash !== contentHash)
              throw new Error("Provisioning replay conflict");
            return { ...previous.result, status: "already-applied" };
          }
          await options.providerRuntime.start();
          const before = await readProvisionablePersonalConfig(
            options.personalRepository,
            options.personalConfigFilePath,
          );
          let committed = false;
          try {
            await options.personalRepository.update((current) => {
              if (current.revision !== before.revision)
                throw new Error("Personal revision conflict");
              committed = true;
              return incoming;
            });
            errorCode = "target-refresh-failed";
            const snapshot = await options.providerRuntime.registryService.refresh(
              "generic-provider-provisioning",
            );
            const result: ProviderProvisioningResult = {
              syncId: envelope.syncId,
              status: "applied",
              personalProviderCount: incoming.providers.keys().length,
              credentialCount: 0,
              configRevision: snapshot.sourceRevisions.config,
              rolledBack: false,
            };
            errorCode = "target-commit-failed";
            await atomicWritePrivateTextFile(
              options.stateFilePath,
              JSON.stringify(
                {
                  ...receipts,
                  records: [...receipts.records, { syncId: envelope.syncId, contentHash, result }],
                },
                null,
                2,
              ),
            );
            return result;
          } catch {
            if (errorCode === "target-commit-failed") {
              try {
                // 原子 rename 后的异常可能发生在提交已完成后；先确认 receipt，不能回滚已确认的提交。
                const committedReceipt = (await readReceipts(options.stateFilePath)).records.find(
                  (record) =>
                    record.syncId === envelope.syncId && record.contentHash === contentHash,
                );
                if (committedReceipt) return committedReceipt.result;
              } catch {
                return failed(envelope.syncId, errorCode, false);
              }
            }
            if (committed) {
              try {
                await options.personalRepository.update((current) => {
                  // 失败回包不能用旧快照覆盖另一个窗口已保存的新配置。
                  const currentHash = hash(encodeProviderConfigFile(current));
                  if (currentHash === hash(encodeProviderConfigFile(before))) return current;
                  if (currentHash !== contentHash) throw new Error("Rollback revision conflict");
                  return before;
                });
                await options.providerRuntime.registryService.refresh(
                  "generic-provider-provisioning-rollback",
                );
              } catch {
                return failed(envelope.syncId, errorCode, false);
              }
            }
            return failed(envelope.syncId, errorCode, true);
          }
        });
      } catch {
        return failed(input.syncId, errorCode, true);
      }
    },
  };
}

async function readReceipts(filePath: string): Promise<z.infer<typeof receiptSchema>> {
  try {
    const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
    const legacy = z
      .object({
        schemaVersion: z.literal(1),
        records: z.array(
          z
            .object({ syncId: z.string().min(1), result: providerProvisioningResultSchema })
            .strict(),
        ),
      })
      .strict()
      .safeParse(raw);
    if (legacy.success) {
      // 旧已知 receipt 没有内容 hash，保留 ID 防止旧请求重新提交，不把它伪装为 v3 已应用。
      const migrated = {
        schemaVersion: 2 as const,
        records: [],
        retiredSyncIds: legacy.data.records.map((record) => record.syncId),
      };
      await atomicWritePrivateTextFile(filePath, JSON.stringify(migrated, null, 2));
      return migrated;
    }
    return receiptSchema.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return { schemaVersion: 2, records: [] };
    // 未知/损坏记录不是空表，保持原样并阻止覆盖。
    throw error;
  }
}
function failed(
  syncId: string,
  errorCode: ProviderProvisioningErrorCode,
  rolledBack: boolean,
): ProviderProvisioningResult {
  return {
    syncId,
    status: rolledBack ? "failed" : "rollback_failed",
    personalProviderCount: 0,
    credentialCount: 0,
    rolledBack,
    errorCode,
    errorMessage: "Provider configuration synchronization failed",
  };
}
