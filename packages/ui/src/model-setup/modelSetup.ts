import {
  parseModelConfig,
  parseProviderConfig,
  type SaveGenericSetupInput,
  type ProviderAuthMode,
} from "@zcode/provider";
import type { ModelSelectionView } from "@zcode/services";
import {
  parseProviderHeadersDraft,
  type ProviderDraftValues,
} from "@/settings/model-provider-section/ProviderDraftSave.js";

export interface ModelSetupDraft extends ProviderDraftValues {
  authMode: ProviderAuthMode;
  headersValue: string;
  modelId: string;
  contextWindow: string;
  maxOutputTokens: string;
  supportsToolCall: boolean;
}

export function buildModelSetupInput(
  setupId: string,
  draft: ModelSetupDraft,
): SaveGenericSetupInput {
  const headers = parseProviderHeadersDraft(draft.headersValue);
  const contextWindow = Number(draft.contextWindow);
  const maxOutputTokens = Number(draft.maxOutputTokens);
  if (
    !headers ||
    !draft.nameValue.trim() ||
    !draft.modelId.trim() ||
    !Number.isInteger(contextWindow) ||
    contextWindow <= 0 ||
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens <= 0 ||
    maxOutputTokens > contextWindow
  )
    throw new Error("Invalid setup fields");
  const provider = parseProviderConfig({
    access: {
      type: "api-key",
      authMode: draft.authMode,
      ...(draft.authMode === "api-key" ? { apiKey: draft.apiKeyValue.trim() } : {}),
    },
    api: { type: draft.apiFormat, baseUrl: draft.baseUrlValue.trim().replace(/\/+$/, ""), headers },
  });
  // 完整性使用领域 Schema；表单不维护另一份鉴权/URL 合法性规则。
  if (
    provider.overlay(parseProviderConfig({ group: "standard-personal" })).validateComplete().length
  )
    throw new Error("Invalid provider configuration");
  const model = parseModelConfig({
    enabled: true,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: draft.supportsToolCall,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: { values: ["disabled"], map: "{}" },
      maxOutputTokens: {
        max: maxOutputTokens,
        map:
          draft.apiFormat === "anthropic-messages"
            ? "{'max_tokens': maxOutputTokens}"
            : draft.apiFormat === "openai-chat-completions"
              ? "{'max_completion_tokens': maxOutputTokens}"
              : "{'max_output_tokens': maxOutputTokens}",
      },
    },
  });
  return {
    setupId,
    providerName: draft.nameValue.trim(),
    providerConfig: provider.toJSON(),
    modelId: draft.modelId.trim(),
    modelConfig: model.toJSON(),
  };
}

export async function finishModelSetup(commands: {
  save(): Promise<unknown>;
  updateSettings(): Promise<unknown>;
  readSelection(): Promise<ModelSelectionView>;
  complete(): void | Promise<void>;
}): Promise<void> {
  await commands.save();
  await commands.updateSettings();
  const view = await commands.readSelection();
  if (!view.preferredSelection?.options?.reasoningLevel)
    throw new Error("Configured model is not available");
  await commands.complete();
}
