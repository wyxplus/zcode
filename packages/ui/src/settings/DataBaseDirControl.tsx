import { FolderOpen, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  TID_SETTINGS_DATA_BASE_DIR_BROWSE,
  TID_SETTINGS_DATA_BASE_DIR_INPUT,
  TID_SETTINGS_DATA_BASE_DIR_SAVE,
  TID_SETTINGS_DATA_BASE_DIR_STATUS,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { dataDirectoryMigrationErrorMessageId } from "./dataDirectoryMigrationError.js";

export function DataBaseDirControl({
  dataBaseDir,
  defaultHomeDir,
  onDataBaseDirChange,
  onSelectDataBaseDir,
}: {
  dataBaseDir: string;
  defaultHomeDir: string;
  onDataBaseDirChange: (dir: string) => Promise<void>;
  onSelectDataBaseDir: () => Promise<string | null>;
}) {
  const { intl } = useZCodeIntl();
  const effectiveDir = dataBaseDir || defaultHomeDir;
  const [localDataBaseDir, setLocalDataBaseDir] = useState(effectiveDir);
  const [isPickingDataBaseDir, setIsPickingDataBaseDir] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorDetail, setErrorDetail] = useState("");
  const [errorMessageId, setErrorMessageId] = useState("settings.dataBaseDirCopyFailed");

  useEffect(() => {
    setLocalDataBaseDir(effectiveDir);
  }, [effectiveDir]);

  const isDirty = localDataBaseDir.trim() !== effectiveDir;
  const isSaving = saveState === "saving" || saveState === "saved";

  const handleBrowseDataBaseDir = useCallback(async () => {
    setIsPickingDataBaseDir(true);
    try {
      const selectedDir = await onSelectDataBaseDir();
      if (!selectedDir) {
        return;
      }

      // 之前这里允许手输任意字符串，用户填错路径后仍会触发整份数据复制。
      // 这里只接受系统目录弹窗返回的真实文件夹路径，先更新草稿值，再显式触发迁移并重启，
      // 避免把“浏览目录”和“执行数据迁移”这两个风险不同的动作混在一起。
      setLocalDataBaseDir(selectedDir);
      if (saveState !== "idle") {
        setSaveState("idle");
      }
    } finally {
      setIsPickingDataBaseDir(false);
    }
  }, [onSelectDataBaseDir, saveState]);

  const handleSave = useCallback(async () => {
    const trimmed = localDataBaseDir.trim();
    setSaveState("saving");
    try {
      await onDataBaseDirChange(trimmed);
      setSaveState("saved");
    } catch (error) {
      setErrorMessageId(dataDirectoryMigrationErrorMessageId(error));
      setErrorDetail(error instanceof Error ? error.message : String(error));
      setSaveState("error");
    }
  }, [localDataBaseDir, onDataBaseDirChange]);

  return (
    <div className="flex w-[320px] min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <FolderOpen className="size-4 shrink-0 text-foreground-subtle" />
        <Input
          size="lg"
          data-testid={TID_SETTINGS_DATA_BASE_DIR_INPUT}
          value={localDataBaseDir}
          readOnly
          disabled={isSaving || isPickingDataBaseDir}
          placeholder={intl.formatMessage({ id: "settings.dataBaseDirPlaceholder" })}
          className="flex-1 font-mono"
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={TID_SETTINGS_DATA_BASE_DIR_BROWSE}
          disabled={isSaving || isPickingDataBaseDir}
          onClick={() => void handleBrowseDataBaseDir()}
        >
          {intl.formatMessage({ id: "settings.dataBaseDirBrowse" })}
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid={TID_SETTINGS_DATA_BASE_DIR_SAVE}
          disabled={!isDirty || isSaving || isPickingDataBaseDir}
          onClick={() => void handleSave()}
        >
          {isSaving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            intl.formatMessage({ id: "settings.dataBaseDirMigrate" })
          )}
        </Button>
      </div>
      {saveState === "saving" ? (
        <p
          data-testid={TID_SETTINGS_DATA_BASE_DIR_STATUS}
          data-state="saving"
          className="text-ui-base text-foreground-subtle"
        >
          {intl.formatMessage({ id: "settings.dataBaseDirCopying" })}
        </p>
      ) : saveState === "saved" ? (
        <p
          data-testid={TID_SETTINGS_DATA_BASE_DIR_STATUS}
          data-state="saved"
          className="text-ui-base text-amber-600 dark:text-amber-400"
        >
          {intl.formatMessage({ id: "settings.dataBaseDirRestartRequired" })}
        </p>
      ) : saveState === "error" ? (
        <div
          data-testid={TID_SETTINGS_DATA_BASE_DIR_STATUS}
          data-state="error"
          className="text-ui-base text-destructive"
        >
          <p>{intl.formatMessage({ id: errorMessageId })}</p>
          <details className="mt-1">
            <summary className="cursor-pointer">
              {intl.formatMessage({ id: "settings.dataBaseDirErrorDetails" })}
            </summary>
            <p className="mt-1 break-words text-ui-sm">{errorDetail}</p>
          </details>
        </div>
      ) : null}
    </div>
  );
}
