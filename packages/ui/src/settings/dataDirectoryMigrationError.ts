import { isDataBaseDirForbiddenWindowsInstallDirError } from "@zcode/shared";

export function dataDirectoryMigrationErrorMessageId(error: unknown): string {
  if (isDataBaseDirForbiddenWindowsInstallDirError(error))
    return "settings.dataBaseDirForbiddenInstallDir";
  const message = String(error);
  if (/DATA_DIRECTORY_TARGET_NOT_EMPTY/.test(message)) return "settings.dataBaseDirNotEmpty";
  if (/ZCODE_DATA_IN_USE|pending work|in.flight|busy/i.test(message))
    return "settings.dataBaseDirBusy";
  if (/SOURCE_CONFLICT|AMBIGUOUS_SOURCE|INVALID_CONFIG|INVALID_SOURCE/.test(message))
    return "settings.dataBaseDirSourceConflict";
  if (/INTEGRITY|SOURCE_CHANGED|CREDENTIALS_UNREADABLE|MISSING_REFERENCE/.test(message))
    return "settings.dataBaseDirIntegrityFailed";
  if (/INSUFFICIENT_SPACE|ENOSPC/.test(message)) return "settings.dataBaseDirNoSpace";
  if (/EACCES|EPERM/.test(message)) return "settings.dataBaseDirPermissionDenied";
  if (/INVALID_TARGET|ENOENT/.test(message)) return "settings.dataBaseDirInvalidTarget";
  return "settings.dataBaseDirCopyFailed";
}
