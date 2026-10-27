import { useRef, useState } from "react";
import { type ModelSelection } from "@zcode/provider";
import { useServices } from "./useServices.js";
import {
  buildModelSetupInput,
  finishModelSetup,
  type ModelSetupDraft,
} from "@/model-setup/modelSetup.js";

/** 向导仅拥有未提交草稿/稳定请求 ID；配置、默认和 skip 均由现有 Host owner 保存。 */
export function useModelSetup(onComplete: (reason: "apiKey" | "skip") => void | Promise<void>) {
  const { providerSettingsService, modelSelectionService, settingService } = useServices();
  const setupId = useRef<string | null>(null);
  const admitted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const run = async (operation: () => Promise<void>) => {
    if (admitted.current) return;
    admitted.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await operation();
    } catch {
      setFailed(true);
    } finally {
      admitted.current = false;
      setBusy(false);
    }
  };
  const finish = (save: () => Promise<unknown>) =>
    finishModelSetup({
      save,
      updateSettings: () => settingService.update({ modelSetupSkipped: false }),
      readSelection: () => modelSelectionService.getView(),
      complete: () => onComplete("apiKey"),
    });
  return {
    busy,
    failed,
    save: (draft: ModelSetupDraft) =>
      run(() => {
        setupId.current ??= crypto.randomUUID();
        const input = buildModelSetupInput(setupId.current, draft);
        return finish(() => providerSettingsService.saveGenericSetup(input));
      }),
    useExisting: (selection: ModelSelection) =>
      run(async () => {
        const view = await providerSettingsService.getView();
        await finish(() =>
          providerSettingsService.saveConfiguredDefault({
            selection,
            basedOnRevision: view.revision,
          }),
        );
      }),
    skip: () =>
      run(async () => {
        await settingService.update({ modelSetupSkipped: true });
        await onComplete("skip");
      }),
  };
}
