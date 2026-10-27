import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_CHAT_ERROR_BANNER,
  TID_LOGIN_TRIGGER,
  TID_LOGIN_MENU_ITEM,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
  waitForWorkspaceApp,
} from "../../../helpers/desktop-app.js";
import { reloadE2EElectronServiceBridge } from "../../../helpers/e2e-electron-service-lifecycle.js";

describe("E2E_API_ONLY_FIRST_RUN no account model setup", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("API-ONLY-01/03/12: skips without identity, retains draft on blocked send and remembers across restart", async function () {
    this.timeout(180000);
    await waitForTestIdByDom("model-setup-page", { timeout: 30000 });
    expect(
      await browser.execute(() =>
        Boolean(document.querySelector('[data-testid="oauth-login-button"]')),
      ),
    ).toBe(false);
    await clickTestIdByDom("model-setup-skip");
    await waitForWorkspaceApp(getE2EAppDataPaths().workspace, 30000);
    await waitForTestIdByDom(TID_CHAT_ERROR_BANNER, { timeout: 30000 });
    const settingsPath = join(getE2EAppDataPaths().appDataDir, "setting.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.modelSetupSkipped).toBe(true);
    expect(
      JSON.parse(await readFile(join(getE2EAppDataPaths().appDataDir, "credentials.json"), "utf8")),
    ).toEqual({});
    const draft = "E2E_API_ONLY_FIRST_RUN unsent draft";
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, draft);
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            (document.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null)
              ?.disabled === true,
          TID_V4_COMPOSER_SEND,
        ),
      { timeout: 10000 },
    );
    expect(
      await browser.execute((id) => {
        const input = document.querySelector(`[data-testid="${id}"]`) as HTMLElement & {
          __zcodeLexicalInputE2E?: { getText(): string };
        };
        return input?.__zcodeLexicalInputE2E?.getText();
      }, TID_V4_COMPOSER_INPUT),
    ).toBe(draft);
    expect(
      await browser.execute(() => localStorage.getItem("zcode-v4-pending-commands:v1")),
    ).toBeNull();
    await browser.reloadSession();
    await reloadE2EElectronServiceBridge(browser);
    await waitForWorkspaceApp(getE2EAppDataPaths().workspace, 30000);
    expect(
      await browser.execute(() =>
        Boolean(document.querySelector('[data-testid="model-setup-page"]')),
      ),
    ).toBe(false);
    expect(JSON.parse(await readFile(settingsPath, "utf8")).modelSetupSkipped).toBe(true);
    await clickTestIdByWebDriver(TID_LOGIN_TRIGGER);
    await waitForTestIdByDom(TID_LOGIN_MENU_ITEM);
    await clickTestIdByWebDriver(TID_LOGIN_MENU_ITEM);
    await waitForTestIdByDom("model-setup-page");
    await setInputValueByTestIdDom("model-setup-nameValue", "E2E_API_ONLY_FIRST_RUN");
    await setInputValueByTestIdDom("model-setup-baseUrlValue", "http://localhost:8080/v1");
    await clickTestIdByWebDriver("model-provider-auth-mode-trigger");
    await clickTestIdByWebDriver("model-provider-auth-mode-none");
    await setInputValueByTestIdDom("model-setup-modelId", "arbitrary-model");
    await setInputValueByTestIdDom("model-setup-contextWindow", "16000");
    await setInputValueByTestIdDom("model-setup-maxOutputTokens", "4000");
    await clickTestIdByDom("model-setup-save");
    await waitForWorkspaceApp(getE2EAppDataPaths().workspace, 30000);
    const config = JSON.parse(await readFile(getE2EAppDataPaths().configFile, "utf8")).config;
    expect(config.providerConfigRules.providerRules).toHaveLength(1);
    const providerId = config.providerConfigRules.providerRules[0].providerId;
    expect(config.defaultModelSelection).toEqual({
      providerId,
      modelId: "arbitrary-model",
      options: { reasoningLevel: "disabled" },
    });
    expect(JSON.parse(await readFile(settingsPath, "utf8")).modelSetupSkipped).toBe(false);
    await browser.reloadSession();
    await reloadE2EElectronServiceBridge(browser);
    await waitForWorkspaceApp(getE2EAppDataPaths().workspace, 30000);
    expect(
      await browser.execute(() =>
        Boolean(document.querySelector('[data-testid="model-setup-page"]')),
      ),
    ).toBe(false);
    expect(
      JSON.parse(await readFile(getE2EAppDataPaths().configFile, "utf8")).config
        .defaultModelSelection.providerId,
    ).toBe(providerId);
  });
});
