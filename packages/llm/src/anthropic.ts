// Adaptador do Claude (API da Anthropic) via SDK oficial. Roda só no processo principal do Electron:
// a chave nunca chega à interface.
import Anthropic from "@anthropic-ai/sdk";

import {
  ProviderError,
  type ChatMessage,
  type Completion,
  type CompletionRequest,
  type LlmProvider,
  type ModelInfo,
  type StopKind,
} from "./types.js";

export const ANTHROPIC_MODELS: ModelInfo[] = [
  {
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    note: "Rápido e barato. Bom para o dia a dia.",
    pricing: {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      longContext: { aboveInputTokens: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
    },
  },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    note: "Mais capaz para tarefas longas. Cerca de 20 vezes o preço do Haiku.",
    pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  },
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    note: "O mais capaz. Cerca de 40 vezes o preço do Haiku.",
    pricing: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  },
];

export interface AnthropicProviderOptions {
  apiKey: string;
  /** Para testes: substitui o cliente do SDK. */
  client?: Pick<Anthropic, "messages">;
}

export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic";
  readonly label = "Claude (API da Anthropic)";
  readonly models = ANTHROPIC_MODELS;
  readonly defaultModel = "claude-haiku-5-5";
  private readonly client: Pick<Anthropic, "messages">;

  constructor(options: AnthropicProviderOptions) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 2 });
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(
        {
          model: request.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          tools: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
          })),
          messages: toAnthropicMessages(request.messages, this.id),
          // Cache automático: o histórico da conversa é reaproveitado entre as chamadas do mesmo pedido,
          // o que barateia bastante o laço de ferramentas.
          cache_control: { type: "ephemeral" },
        },
        request.signal ? { signal: request.signal } : undefined,
      );
    } catch (err) {
      throw translateError(err);
    }

    const toolCalls = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return {
      text,
      toolCalls,
      stop: stopKind(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
      raw: response.content,
    };
  }
}

function stopKind(reason: Anthropic.StopReason | null): StopKind {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

/** Converte o histórico neutro. Mensagens seguidas do mesmo papel são unidas (resultados de ferramenta + texto novo). */
export function toAnthropicMessages(messages: ChatMessage[], providerId: string): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  const push = (role: "user" | "assistant", blocks: Anthropic.ContentBlockParam[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) {
      const prev = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
      last.content = [...prev, ...blocks];
    } else {
      out.push({ role, content: blocks });
    }
  };
  for (const m of messages) {
    if (m.role === "user") push("user", [{ type: "text", text: m.text }]);
    else if (m.role === "tool")
      push(
        "user",
        m.results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.callId, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
      );
    else if (m.provider === providerId && Array.isArray(m.raw)) push("assistant", m.raw as Anthropic.ContentBlockParam[]);
    else
      push("assistant", [
        ...(m.text ? [{ type: "text" as const, text: m.text }] : []),
        ...m.toolCalls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
      ]);
  }
  return out;
}

function translateError(err: unknown): ProviderError {
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError("aborted", "Pedido interrompido.");
  if (err instanceof Anthropic.AuthenticationError)
    return new ProviderError("auth", "A chave da API foi recusada. Confira a chave nas configurações.");
  if (err instanceof Anthropic.PermissionDeniedError)
    return new ProviderError("auth", "A chave não tem permissão para este modelo. Confira a conta no console da Anthropic.");
  if (err instanceof Anthropic.RateLimitError)
    return new ProviderError("rate_limit", "Limite de uso da API atingido. Espere um pouco ou confira os limites da sua conta.");
  if (err instanceof Anthropic.APIConnectionError)
    return new ProviderError("network", "Não consegui falar com a API da Anthropic. Confira sua conexão.");
  if (err instanceof Anthropic.BadRequestError) {
    const message = err.message.toLowerCase();
    if (message.includes("credit balance")) return new ProviderError("auth", "Sua conta da API está sem crédito. Adicione crédito no console da Anthropic.");
    return new ProviderError("bad_request", `A API recusou o pedido: ${err.message}`);
  }
  if (err instanceof Anthropic.APIError && (err.status === 529 || err.status === 503))
    return new ProviderError("overloaded", "A API está sobrecarregada agora. Tente de novo em instantes.");
  if (err instanceof Anthropic.APIError) return new ProviderError("other", `Erro da API (${err.status ?? "?"}): ${err.message}`);
  return new ProviderError("other", err instanceof Error ? err.message : String(err));
}
