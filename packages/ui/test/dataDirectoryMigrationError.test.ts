import { describe, expect, it } from "vitest";
import { dataDirectoryMigrationErrorMessageId } from "../src/settings/dataDirectoryMigrationError.js";

describe("migration failure messages", () => {
  it.each([
    ["DATA_DIRECTORY_TARGET_NOT_EMPTY", "settings.dataBaseDirNotEmpty"],
    ["ZCODE_DATA_IN_USE", "settings.dataBaseDirBusy"],
    ["DATA_DIRECTORY_SOURCE_CONFLICT", "settings.dataBaseDirSourceConflict"],
    ["DATA_DIRECTORY_INVALID_CONFIG", "settings.dataBaseDirSourceConflict"],
    ["DATA_DIRECTORY_INTEGRITY", "settings.dataBaseDirIntegrityFailed"],
    ["DATA_DIRECTORY_SOURCE_CHANGED", "settings.dataBaseDirIntegrityFailed"],
    ["DATA_DIRECTORY_CREDENTIALS_UNREADABLE", "settings.dataBaseDirIntegrityFailed"],
    ["DATA_DIRECTORY_INSUFFICIENT_SPACE", "settings.dataBaseDirNoSpace"],
    ["EACCES", "settings.dataBaseDirPermissionDenied"],
    ["DATA_DIRECTORY_INVALID_TARGET", "settings.dataBaseDirInvalidTarget"],
  ])("presents %s as a distinct actionable failure", (code, expected) => {
    expect(dataDirectoryMigrationErrorMessageId(new Error(code))).toBe(expected);
  });
});
