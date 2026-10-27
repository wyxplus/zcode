import { useState } from "react";
import { completeNewModelSelection } from "@zcode/provider";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Switch } from "@/components/ui/switch.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { DesktopOverlayWindowControls } from "@/DesktopOverlayWindowControls.js";
import { useModelSetup } from "@/hooks/useModelSetup.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ProviderApiFormatSelect } from "@/settings/model-provider-section/ProviderApiFormatSelect.js";
import { ProviderAuthModeFields } from "@/settings/model-provider-section/ProviderAuthModeFields.js";
import { ApiKeyInput } from "@/settings/model-provider-section/ApiKeyInput.js";
import type { ModelSetupDraft } from "./modelSetup.js";

export function ModelSetupPage({
  onComplete,
}: {
  onComplete: (reason: "apiKey" | "skip") => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const message = (id: string) => intl.formatMessage({ id });
  const setup = useModelSetup(onComplete);
  const { modelSelectionService } = useServices();
  const read = useModelSelectionServiceView(modelSelectionService);
  const view = read.state.status === "ready" ? read.state.view : null;
  const existing =
    view?.providers.flatMap((provider) =>
      provider.config.access?.type === "api-key"
        ? provider.models.map((model) => ({
            providerId: provider.providerId,
            modelId: model.modelId,
          }))
        : [],
    ) ?? [];
  const [existingIndex, setExistingIndex] = useState("");
  const [keyVisible, setKeyVisible] = useState(false);
  const [draft, setDraft] = useState<ModelSetupDraft>({
    nameValue: "",
    apiFormat: "openai-chat-completions",
    baseUrlValue: "",
    authMode: "api-key",
    apiKeyValue: "",
    headersValue: "",
    modelId: "",
    contextWindow: "",
    maxOutputTokens: "",
    supportsToolCall: true,
  });
  const change = (patch: Partial<ModelSetupDraft>) => setDraft((value) => ({ ...value, ...patch }));
  const field = (
    key: "nameValue" | "baseUrlValue" | "modelId" | "contextWindow" | "maxOutputTokens",
    title: string,
    numeric = false,
  ) => (
    <div className="space-y-2">
      <Label htmlFor={`setup-${key}`}>{message(title)}</Label>
      <Input
        id={`setup-${key}`}
        data-testid={`model-setup-${key}`}
        value={draft[key]}
        required
        inputMode={numeric ? "numeric" : undefined}
        type={numeric ? "number" : "text"}
        min={numeric ? 1 : undefined}
        autoComplete="off"
        spellCheck={false}
        className="text-mobile-input-safe md:text-ui-base"
        onChange={(event) => change({ [key]: event.target.value })}
      />
    </div>
  );
  return (
    <main
      className="relative h-full min-h-dvh overflow-y-auto bg-background px-4 pt-16 pb-8 text-foreground"
      data-testid="model-setup-page"
    >
      <div className="pointer-events-none absolute left-0 top-0 right-0 h-12 [app-region:drag] platform-windows-desktop:right-[134px] platform-linux-desktop:right-[134px]" />
      <DesktopOverlayWindowControls />
      <section className="mx-auto w-full max-w-xl space-y-6 rounded-2xl border border-popover-border p-6 sm:p-8">
        <header className="space-y-2">
          <h1 className="text-xl font-semibold">{message("modelSetup.title")}</h1>
          <p className="text-ui-base text-foreground-subtle">{message("modelSetup.description")}</p>
        </header>
        {existing.length ? (
          <div className="space-y-3">
            <Label>{message("modelSetup.existing")}</Label>
            <Select value={existingIndex} onValueChange={setExistingIndex} disabled={setup.busy}>
              <SelectTrigger data-testid="model-setup-existing">
                <SelectValue placeholder={message("modelSetup.existing")} />
              </SelectTrigger>
              <SelectContent>
                {existing.map((item, index) => (
                  <SelectItem key={JSON.stringify(item)} value={String(index)}>
                    {item.providerId} / {item.modelId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              disabled={setup.busy || !existingIndex || !view}
              onClick={() => {
                const item = existing[Number(existingIndex)];
                const selection = item && view && completeNewModelSelection(view, item);
                if (selection) void setup.useExisting(selection);
              }}
            >
              {message("modelSetup.useExisting")}
            </Button>
          </div>
        ) : null}
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void setup.save(draft);
          }}
        >
          <fieldset disabled={setup.busy} className="space-y-4">
            {field("nameValue", "settings.modelProvider.name")}
            <ProviderApiFormatSelect
              value={draft.apiFormat}
              onChange={(apiFormat) => change({ apiFormat })}
            />
            {field("baseUrlValue", "settings.modelProvider.baseUrl")}
            <ProviderAuthModeFields
              mode={draft.authMode}
              headersValue={draft.headersValue}
              onModeChange={(authMode) => change({ authMode, apiKeyValue: "" })}
              onHeadersChange={(headersValue) => change({ headersValue })}
              onHeadersBlur={() => {}}
            />
            {draft.authMode === "api-key" ? (
              <ApiKeyInput
                value={draft.apiKeyValue}
                visible={keyVisible}
                onChange={(apiKeyValue) => change({ apiKeyValue })}
                onBlur={() => {}}
                onToggleVisibility={() => setKeyVisible((value) => !value)}
              />
            ) : null}
            {field("modelId", "settings.modelProvider.modelId")}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {field("contextWindow", "settings.modelProvider.contextWindow", true)}
              {field("maxOutputTokens", "settings.modelProvider.maxOutputTokens", true)}
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="setup-tools">
                {message("settings.modelProvider.supportsToolCall")}
              </Label>
              <Switch
                id="setup-tools"
                checked={draft.supportsToolCall}
                onCheckedChange={(supportsToolCall) => change({ supportsToolCall })}
              />
            </div>
            <p className="text-ui-sm text-foreground-subtle">
              {message("modelSetup.capabilitiesHint")}
            </p>
            <Button type="submit" className="w-full" data-testid="model-setup-save">
              {message(setup.busy ? "modelSetup.saving" : "modelSetup.save")}
            </Button>
          </fieldset>
        </form>
        {setup.failed ? (
          <p role="alert" data-testid="model-setup-error" className="text-ui-base text-destructive">
            {message("modelSetup.error")}
          </p>
        ) : null}
        <Button
          variant="ghost"
          disabled={setup.busy}
          className="w-full"
          data-testid="model-setup-skip"
          onClick={() => void setup.skip()}
        >
          {message("modelSetup.skip")}
        </Button>
      </section>
    </main>
  );
}
