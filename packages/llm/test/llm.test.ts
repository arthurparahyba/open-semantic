import { describe, expect, it } from "vitest";

import { ANTHROPIC_MODELS, AnthropicProvider, costOf, toAnthropicMessages, type ChatMessage } from "../src/index.js";

const haiku = ANTHROPIC_MODELS.find((m) => m.id === "claude-haiku-5-5")!;

describe("custo", () => {
  it("cobra entrada, saída e cache pelo preço do modelo", () => {
    const cost = costOf({ inputTokens: 50_000, outputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, haiku.pricing);
    expect(cost).toBeCloseTo(0.005 + 0.005, 6);
    const cached = costOf({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 50_000, cacheWriteTokens: 10_000 }, haiku.pricing);
    expect(cached).toBeCloseTo(0.0005 + 0.00125, 6);
  });

  it("usa a faixa de contexto longo quando o prompt da chamada passa do limite", () => {
    const cost = costOf({ inputTokens: 120_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, haiku.pricing);
    expect(cost).toBeCloseTo(0.06, 6);
  });
});

describe("conversão para a API do Claude", () => {
  it("reenvia a resposta do Claude intacta e une resultados de ferramenta com o texto seguinte", () => {
    const raw = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "tool_use", id: "tu_1", name: "get_workspace", input: {} },
    ];
    const history: ChatMessage[] = [
      { role: "user", text: "oi" },
      { role: "assistant", text: "", toolCalls: [{ id: "tu_1", name: "get_workspace", input: {} }], raw, provider: "anthropic" },
      { role: "tool", results: [{ callId: "tu_1", content: "não executado", isError: true }] },
      { role: "user", text: "e agora?" },
    ];
    const out = toAnthropicMessages(history, "anthropic");
    expect(out).toHaveLength(3);
    expect(out[1]!.content).toBe(raw);
    expect(out[2]!.role).toBe("user");
    expect(out[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "tu_1", content: "não executado", is_error: true },
      { type: "text", text: "e agora?" },
    ]);
  });

  it("monta blocos a partir do formato neutro quando a resposta veio de outro provedor", () => {
    const out = toAnthropicMessages(
      [{ role: "assistant", text: "vou olhar", toolCalls: [{ id: "c1", name: "list_dir", input: { path: "." } }], raw: { other: true }, provider: "openai" }],
      "anthropic",
    );
    expect(out[0]!.content).toEqual([
      { type: "text", text: "vou olhar" },
      { type: "tool_use", id: "c1", name: "list_dir", input: { path: "." } },
    ]);
  });
});

describe("AnthropicProvider", () => {
  it("pede cache automático, traduz a resposta e o uso de tokens", async () => {
    let params: Record<string, unknown> | undefined;
    const client = {
      messages: {
        create: async (p: Record<string, unknown>) => {
          params = p;
          return {
            content: [
              { type: "text", text: "Vou ver o workspace." },
              { type: "tool_use", id: "tu_9", name: "get_workspace", input: {} },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 },
          };
        },
      },
    };
    const provider = new AnthropicProvider({ apiKey: "x", client: client as never });
    const result = await provider.complete({
      model: "claude-haiku-5-5",
      system: "sistema",
      messages: [{ role: "user", text: "oi" }],
      tools: [{ name: "get_workspace", description: "d", inputSchema: { type: "object", properties: {} } }],
      maxOutputTokens: 4000,
    });
    expect(params!.cache_control).toEqual({ type: "ephemeral" });
    expect(params!.model).toBe("claude-haiku-5-5");
    expect(result.stop).toBe("tool_use");
    expect(result.text).toBe("Vou ver o workspace.");
    expect(result.toolCalls).toEqual([{ id: "tu_9", name: "get_workspace", input: {} }]);
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 40, cacheReadTokens: 3000, cacheWriteTokens: 0 });
  });
});
