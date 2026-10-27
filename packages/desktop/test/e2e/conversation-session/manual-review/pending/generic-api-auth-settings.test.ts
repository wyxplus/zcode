import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderApiType } from "@zcode/provider";
import {
  TID_MODEL_PROVIDER_API_FORMAT_ITEM,
  TID_MODEL_PROVIDER_API_FORMAT_TRIGGER,
  TID_MODEL_PROVIDER_API_KEY_INPUT,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  getE2EAppDataPaths,
  readModelProviders,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
  waitForWorkspaceApp,
} from "../../../helpers/desktop-app.js";
import { createAndConfigurePersonalProvider } from "../../../helpers/personal-provider-settings.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";

interface StoredProvider {
  providerId: string;
  config: {
    access?: { authMode?: string; apiKey?: string | null };
    api?: { type?: string; headers?: Record<string, string> };
  };
}
async function readProvider(id: string): Promise<StoredProvider | undefined> {
  const document = JSON.parse(await readFile(getE2EAppDataPaths().configFile, "utf8")) as {
    config: { providerConfigRules: { providerRules: StoredProvider[] } };
  };
  return document.config.providerConfigRules.providerRules.find(
    (provider) => provider.providerId === id,
  );
}
async function waitForStored(id: string, predicate: (provider: StoredProvider) => boolean) {
  await browser.waitUntil(
    async () => {
      const provider = await readProvider(id);
      return Boolean(provider && predicate(provider));
    },
    { timeout: 15000, timeoutMsg: "E2E_API_ONLY_AUTH 配置没有通过原保存链提交" },
  );
}

describe("E2E_API_ONLY_AUTH generic provider settings", () => {
  afterEach(async function () {
    if (this.currentTest?.state !== "failed") return;
    const directory = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    const alert = await browser.execute(
      () => document.querySelector('[role="alertdialog"]')?.textContent ?? "no alert dialog",
    );
    await writeFile(join(directory, "generic-api-auth-alert.txt"), alert);
    await browser.saveScreenshot(join(directory, "generic-api-auth-failure.png"));
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("API-ONLY-04/05/06/08/34: persists protocol/auth/header edits and preserves the same provider identity", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E();
    await waitForWorkspaceApp(getE2EAppDataPaths().workspace, 30000);
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await waitForTestIdByDom(TID_SETTINGS_PAGE);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
    const name = `E2E_API_ONLY_AUTH_${Date.now()}`;
    await createAndConfigurePersonalProvider({
      providerName: name,
      apiFormat: "openai-responses",
      apiKey: "fixture-key",
      baseURL: "http://localhost:8080/proxy/v1",
    });
    let id = "";
    await browser.waitUntil(
      async () => {
        id = (await readModelProviders()).find((provider) => provider.name === name)?.id ?? "";
        return Boolean(id);
      },
      { timeout: 15000 },
    );
    await waitForStored(id, (provider) => provider.config.access?.apiKey === "fixture-key");
    for (const protocol of [
      "anthropic-messages",
      "openai-chat-completions",
      "openai-responses",
    ] as ProviderApiType[]) {
      await clickTestIdByWebDriver(TID_MODEL_PROVIDER_API_FORMAT_TRIGGER);
      await clickTestIdByWebDriver(testId(TID_MODEL_PROVIDER_API_FORMAT_ITEM, protocol));
      await waitForStored(id, (provider) => provider.config.api?.type === protocol);
    }
    await clickTestIdByWebDriver("model-provider-auth-mode-trigger");
    await clickTestIdByWebDriver("model-provider-auth-mode-none");
    await waitForStored(
      id,
      (provider) => provider.config.access?.authMode === "none" && !provider.config.access.apiKey,
    );
    expect(
      await browser.execute(
        (testId) => Boolean(document.querySelector(`[data-testid="${testId}"]`)),
        TID_MODEL_PROVIDER_API_KEY_INPUT,
      ),
    ).toBe(false);
    await clickTestIdByDom("model-provider-headers-toggle");
    await setInputValueByTestIdDom(
      "model-provider-headers-input",
      '{"X-Custom-Auth":"fixture-header"}',
    );
    await clickTestIdByWebDriver("model-provider-auth-mode-trigger");
    await clickTestIdByWebDriver("model-provider-auth-mode-custom-headers");
    await waitForStored(
      id,
      (provider) =>
        provider.config.access?.authMode === "custom-headers" &&
        provider.config.api?.headers?.["X-Custom-Auth"] === "fixture-header" &&
        !provider.config.access.apiKey,
    );
    await setInputValueByTestIdDom("model-provider-headers-input", '{"X-Custom-Auth":');
    expect((await readProvider(id))?.config.api?.headers?.["X-Custom-Auth"]).toBe("fixture-header");
    expect(
      await browser.execute(() =>
        document
          .querySelector('[data-testid="model-provider-headers-input"]')
          ?.getAttribute("aria-invalid"),
      ),
    ).toBe("true");
    await setInputValueByTestIdDom(
      "model-provider-headers-input",
      '{"X-Custom-Auth":"fixture-repaired"}',
    );
    await clickTestIdByDom("model-provider-headers-toggle");
    await waitForStored(
      id,
      (provider) => provider.config.api?.headers?.["X-Custom-Auth"] === "fixture-repaired",
    );
    expect(
      await browser.execute(() =>
        Boolean(document.querySelector('[data-testid="model-provider-headers-input"]')),
      ),
    ).toBe(false);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
    await waitForStored(
      id,
      (provider) =>
        provider.config.access?.authMode === "custom-headers" &&
        provider.config.api?.type === "openai-responses",
    );
    expect((await readModelProviders()).filter((provider) => provider.name === name)).toHaveLength(
      1,
    );
  });
});
