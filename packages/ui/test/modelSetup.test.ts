import { describe, expect, it, vi } from "vitest";
import { buildModelSetupInput, finishModelSetup } from "@/model-setup/modelSetup.js";

const draft = {
  nameValue: " My API ",
  apiFormat: "openai-responses" as const,
  baseUrlValue: "http://localhost:8080/v1/",
  authMode: "none" as const,
  apiKeyValue: "old-secret",
  headersValue: "",
  modelId: " my-model ",
  contextWindow: "16000",
  maxOutputTokens: "4000",
  supportsToolCall: true,
};
describe("model setup contract", () => {
  it("retains arbitrary identity, full no-reasoning model, and drops inactive keys", () => {
    const input = buildModelSetupInput("75e3f8de-e628-4e13-86bc-5098f31cf979", draft);
    expect(input.modelId).toBe("my-model");
    expect(input.providerConfig.access).not.toHaveProperty("apiKey");
    expect(input.modelConfig.optionSpecs?.reasoningLevel).toEqual({
      values: ["disabled"],
      map: "{}",
    });
    expect(input.modelConfig.properties?.supportsToolCall).toBe(true);
  });
  it.each([
    { headersValue: "{bad" },
    { baseUrlValue: "ftp://host" },
    { contextWindow: "0" },
    { maxOutputTokens: "999999" },
    { modelId: " " },
    { authMode: "api-key" as const, apiKeyValue: "" },
  ])("rejects invalid draft before admission", (patch) => {
    expect(() =>
      buildModelSetupInput("75e3f8de-e628-4e13-86bc-5098f31cf979", { ...draft, ...patch }),
    ).toThrow();
  });
  it("only completes after committed default, settings and a usable selection read", async () => {
    const events: string[] = [];
    await finishModelSetup({
      save: async () => {
        events.push("save");
      },
      updateSettings: async () => {
        events.push("settings");
      },
      readSelection: async () => {
        events.push("read");
        return {
          revision: 1,
          providers: [],
          preferredSelection: {
            providerId: "p",
            modelId: "m",
            options: { reasoningLevel: "disabled" },
          },
        };
      },
      complete: async () => {
        events.push("complete");
      },
    });
    expect(events).toEqual(["save", "settings", "read", "complete"]);
  });
  it("keeps the entry open on post-commit failure or absent preferred selection", async () => {
    const complete = vi.fn();
    const commands = {
      save: async () => {},
      updateSettings: async () => {},
      readSelection: async () => ({ revision: 1, providers: [] }),
      complete,
    };
    await expect(finishModelSetup(commands)).rejects.toThrow();
    await expect(
      finishModelSetup({
        ...commands,
        updateSettings: async () => {
          throw new Error("IO failed");
        },
      }),
    ).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });
});
