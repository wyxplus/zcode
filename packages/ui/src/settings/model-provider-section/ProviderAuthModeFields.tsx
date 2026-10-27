import { useId, useState } from "react";
import type { ProviderAuthMode } from "@zcode/provider";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import { Textarea } from "@/components/ui/textarea.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { parseProviderHeadersDraft } from "./ProviderDraftSave.js";

export function ProviderAuthModeFields({
  mode,
  headersValue,
  onModeChange,
  onHeadersChange,
  onHeadersBlur,
}: {
  mode: ProviderAuthMode;
  headersValue: string;
  onModeChange: (mode: ProviderAuthMode) => void;
  onHeadersChange: (value: string) => void;
  onHeadersBlur: () => void;
}) {
  const { intl } = useZCodeIntl();
  const id = useId();
  const [visible, setVisible] = useState(false);
  const invalid = parseProviderHeadersDraft(headersValue) === null;
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={`${id}-mode`}>
          {intl.formatMessage({ id: "settings.modelProvider.authMode" })}
        </Label>
        <Select value={mode} onValueChange={(value) => onModeChange(value as ProviderAuthMode)}>
          <SelectTrigger
            id={`${id}-mode`}
            data-testid="model-provider-auth-mode-trigger"
            className="w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["api-key", "custom-headers", "none"] as const).map((value) => (
              <SelectItem
                key={value}
                value={value}
                data-testid={`model-provider-auth-mode-${value}`}
              >
                {intl.formatMessage({ id: `settings.modelProvider.authMode.${value}` })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`${id}-headers`}>
            {intl.formatMessage({ id: "settings.modelProvider.headers" })}
          </Label>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="model-provider-headers-toggle"
            aria-expanded={visible}
            onClick={() => setVisible((value) => !value)}
          >
            {intl.formatMessage({
              id: visible
                ? "settings.modelProvider.headers.hide"
                : "settings.modelProvider.headers.edit",
            })}
          </Button>
        </div>
        {visible ? (
          <Textarea
            id={`${id}-headers`}
            data-testid="model-provider-headers-input"
            value={headersValue}
            onChange={(event) => onHeadersChange(event.target.value)}
            onBlur={onHeadersBlur}
            rows={4}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={invalid}
            aria-describedby={invalid ? `${id}-error` : `${id}-hint`}
            placeholder={'{"X-Header": "value"}'}
            className="font-mono text-mobile-input-safe md:text-ui-base"
          />
        ) : null}
        <p id={`${id}-hint`} className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.headers.hint" })}
        </p>
        {invalid ? (
          <p id={`${id}-error`} role="alert" className="text-ui-sm text-destructive">
            {intl.formatMessage({ id: "settings.modelProvider.headers.invalid" })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
