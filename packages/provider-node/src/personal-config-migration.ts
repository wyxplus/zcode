import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicWritePrivateTextFile } from "@zcode/shared/node";

const journalSchema = z
  .object({
    schemaVersion: z.literal(1),
    stage: z.enum(["config-pending", "config-complete"]),
    sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
    targetRevision: z.string().regex(/^[a-f0-9]{64}$/),
    completedAt: z.number().int().nonnegative().optional(),
  })
  .strict();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const paths = (filePath: string) => ({
  backup: `${filePath}.generic-api-v1.backup.json`,
  journal: `${filePath}.generic-api-migration.json`,
});
async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}
async function readJournal(filePath: string) {
  const raw = await readOptional(paths(filePath).journal);
  return raw === null ? null : journalSchema.parse(JSON.parse(raw));
}
export async function hasPendingPersonalConfigMigration(filePath: string): Promise<boolean> {
  return (await readJournal(filePath))?.stage === "config-pending";
}

/** 调用者必须持 Personal 文件原有锁；所有校验完成后才创建私有恢复资料。 */
export async function preparePersonalConfigMigration(
  filePath: string,
  source: string,
  target: string,
): Promise<void> {
  const ownedPaths = paths(filePath);
  const sourceRevision = hash(source);
  const targetRevision = hash(target);
  const previous = await readJournal(filePath);
  const backup = await readOptional(ownedPaths.backup);
  if (
    (previous &&
      (previous.sourceRevision !== sourceRevision || previous.targetRevision !== targetRevision)) ||
    (backup !== null && hash(backup) !== sourceRevision)
  ) {
    throw new Error("Personal config migration recovery revision conflict");
  }
  if (backup === null) await atomicWritePrivateTextFile(ownedPaths.backup, source);
  await atomicWritePrivateTextFile(
    ownedPaths.journal,
    JSON.stringify(
      { schemaVersion: 1, stage: "config-pending", sourceRevision, targetRevision },
      null,
      2,
    ),
  );
}

export async function confirmPersonalConfigMigration(
  filePath: string,
  committed: string,
): Promise<void> {
  const previous = await readJournal(filePath);
  // 已有并发编辑时不覆盖配置，也不把另一份 revision 当作本次迁移成功。
  if (
    !previous ||
    previous.stage === "config-complete" ||
    previous.targetRevision !== hash(committed)
  )
    return;
  await atomicWritePrivateTextFile(
    paths(filePath).journal,
    JSON.stringify({ ...previous, stage: "config-complete" }, null, 2),
  );
}
