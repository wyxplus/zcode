import { afterEach, describe, expect, it, vi } from "vitest";
import { generateText, streamText, jsonSchema, tool } from "ai";
import {
  createRegistryProviderConfig,
  parseProviderConfig,
  type ProviderApiType,
  type ProviderAuthMode,
} from "@zcode/provider";
import { AiSdkModelExecution } from "../src/model/model-execution.js";

const protocols: ProviderApiType[] = [
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
];
const modes: ProviderAuthMode[] = ["api-key", "custom-headers", "none"];
const paths = {
  "anthropic-messages": "/messages",
  "openai-chat-completions": "/chat/completions",
  "openai-responses": "/responses",
};

function response(protocol: ProviderApiType) {
  if (protocol === "anthropic-messages")
    return {
      id: "msg-fixture",
      type: "message",
      role: "assistant",
      model: "generic",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 1 },
    };
  if (protocol === "openai-chat-completions")
    return {
      id: "chat-fixture",
      object: "chat.completion",
      created: 1,
      model: "generic",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    };
  return {
    id: "resp-fixture",
    object: "response",
    created_at: 1,
    model: "generic",
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg-fixture",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 2,
      output_tokens: 1,
      total_tokens: 3,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

afterEach(() => vi.unstubAllEnvs());

function bind(protocol: ProviderApiType, transport: typeof fetch) {
  const result = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "api-key", authMode: "none" },
      api: { type: protocol, baseUrl: "https://api.example.test/v1" },
    }),
  );
  if (!result.ok) throw new Error("Expected complete fixture");
  return new AiSdkModelExecution({ env: {} }, { transport })
    .bindModel({
      providerId: "generic",
      modelId: "generic",
      providerConfig: result.config,
      supportsJsonSchemaOutput: false,
      optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
    })
    .resolveRequest({ options: { reasoningLevel: "disabled", maxOutputTokens: 128 } }).model;
}

function sse(protocol: ProviderApiType): string {
  const frame = (event: Record<string, unknown>) =>
    `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
  if (protocol === "anthropic-messages")
    return [
      {
        type: "message_start",
        message: {
          ...response(protocol),
          content: [],
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ]
      .map(frame)
      .join("");
  if (protocol === "openai-chat-completions")
    return (
      [
        {
          id: "chat-fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "generic",
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
        },
        {
          id: "chat-fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "generic",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("") + "data: [DONE]\n\n"
    );
  return [
    { type: "response.created", response: { id: "resp-fixture", created_at: 1, model: "generic" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: "msg-fixture",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg-fixture",
      output_index: 0,
      content_index: 0,
      delta: "ok",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg-fixture",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      },
    },
    { type: "response.completed", response: response(protocol) },
  ]
    .map(frame)
    .join("");
}

describe("Generic protocol execution wire", () => {
  it.each(protocols)(
    "retains %s streamed text and usage with no authentication",
    async (protocol) => {
      const bodies: Record<string, unknown>[] = [];
      const model = bind(protocol, async (_input, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.has("authorization")).toBe(false);
        expect(headers.has("x-api-key")).toBe(false);
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(sse(protocol), { headers: { "content-type": "text/event-stream" } });
      });
      const answer = streamText({ model, prompt: "hello", maxRetries: 0 });
      expect(await answer.text).toBe("ok");
      expect(await answer.usage).toMatchObject({ inputTokens: 2, outputTokens: 1 });
      expect(bodies[0]).toMatchObject({ model: "generic", stream: true });
    },
  );

  it.each(protocols)("retains %s tool names and arguments", async (protocol) => {
    const toolCall = {
      type: "function_call",
      id: "fc-fixture",
      call_id: "call-fixture",
      name: "Count",
      arguments: '{"value":1}',
    };
    const payload =
      protocol === "anthropic-messages"
        ? {
            ...response(protocol),
            content: [{ type: "tool_use", id: "call-fixture", name: "Count", input: { value: 1 } }],
            stop_reason: "tool_use",
          }
        : protocol === "openai-chat-completions"
          ? {
              ...response(protocol),
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call-fixture",
                        type: "function",
                        function: { name: "Count", arguments: '{"value":1}' },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }
          : { ...response(protocol), output: [toolCall] };
    const bodies: Record<string, unknown>[] = [];
    const model = bind(protocol, async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(payload);
    });
    const answer = await generateText({
      model,
      prompt: "count",
      maxRetries: 0,
      tools: {
        Count: tool({
          inputSchema: jsonSchema<{ value: number }>({
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          }),
        }),
      },
    });
    expect(answer.toolCalls).toMatchObject([
      { toolCallId: "call-fixture", toolName: "Count", input: { value: 1 } },
    ]);
    expect(JSON.stringify(bodies[0]?.tools)).toContain("Count");
  });
  it.each(protocols.flatMap((protocol) => modes.map((mode) => ({ protocol, mode }))))(
    "sends $protocol / $mode directly with explicit auth and no reasoning parameters",
    async ({ protocol, mode }) => {
      vi.stubEnv("OPENAI_API_KEY", "environment-key-must-not-leak");
      vi.stubEnv("ANTHROPIC_API_KEY", "environment-key-must-not-leak");
      const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
      const transport: typeof fetch = async (input, init) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json(response(protocol));
      };
      const endpointRoutingPort = {
        resolve: vi.fn(async () => ({
          routed: true,
          url: "https://gateway.example.test/forbidden",
        })),
      };
      const result = createRegistryProviderConfig(
        parseProviderConfig({
          group: "standard-personal",
          access: {
            type: "api-key",
            authMode: mode,
            ...(mode === "api-key" ? { apiKey: "configured-key" } : {}),
          },
          api: {
            type: protocol,
            baseUrl: "https://api.example.test/proxy/v1",
            headers:
              mode === "custom-headers"
                ? { Authorization: "Bearer custom-key", "X-Custom-Auth": "custom-token" }
                : { "X-Client": "fixture" },
          },
        }),
      );
      if (!result.ok) throw new Error("Expected complete fixture");
      const execution = new AiSdkModelExecution({ env: {}, endpointRoutingPort }, { transport });
      const bound = execution.bindModel({
        providerId: "custom-source",
        modelId: "generic",
        providerConfig: result.config,
        supportsJsonSchemaOutput: false,
        optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
      });
      const resolved = bound.resolveRequest({
        options: { reasoningLevel: "disabled", maxOutputTokens: 128 },
        ...(mode === "api-key"
          ? {}
          : {
              requestAuth: {
                apiKey: "attempt-key-must-not-leak",
                headers: {
                  Authorization: "Bearer attempt-key-must-not-leak",
                  "x-api-key": "attempt-key-must-not-leak",
                },
              },
            }),
      });
      const answer = await generateText({ model: resolved.model, prompt: "hello", maxRetries: 0 });
      expect(answer.text).toBe("ok");
      expect(answer.usage.inputTokens).toBe(2);
      expect(answer.usage.outputTokens).toBe(1);
      expect(endpointRoutingPort.resolve).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.url).toBe(`https://api.example.test/proxy/v1${paths[protocol]}`);
      expect(JSON.stringify([...request.headers])).not.toContain("environment-key");
      expect(JSON.stringify([...request.headers])).not.toContain("attempt-key");
      if (mode === "api-key") {
        expect(request.headers.get("authorization")).toBe("Bearer configured-key");
        expect(request.headers.get("x-api-key")).toBe(
          protocol === "anthropic-messages" ? "configured-key" : null,
        );
      } else if (mode === "custom-headers") {
        expect(request.headers.get("authorization")).toBe("Bearer custom-key");
        expect(request.headers.get("x-custom-auth")).toBe("custom-token");
        expect(request.headers.has("x-api-key")).toBe(false);
      } else {
        expect(request.headers.has("authorization")).toBe(false);
        expect(request.headers.has("x-api-key")).toBe(false);
      }
      expect(request.body).not.toHaveProperty("reasoning");
      expect(request.body).not.toHaveProperty("reasoning_effort");
      expect(request.body).not.toHaveProperty("thinking");
    },
  );
});
