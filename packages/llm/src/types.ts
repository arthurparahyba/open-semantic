// Camada de provedores de LLM. O laço do agente (no núcleo) só conhece estes tipos;
// cada provedor (Claude hoje, APIs compatíveis com OpenAI depois) é um adaptador.

/** Preço em dólares por milhão de tokens. */
export interface Pricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Alguns modelos cobram mais quando o prompt passa de um limite (ex.: Haiku acima de 100 mil tokens). */
  longContext?: { aboveInputTokens: number; input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface ModelInfo {
  id: string;
  label: string;
  /** Uma linha para a tela de configurações. */
  note: string;
  pricing: Pricing;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema do objeto de entrada. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  /** Texto (normalmente JSON) devolvido ao modelo. */
  content: string;
  isError?: boolean;
}

/**
 * Mensagem no formato neutro. `raw` guarda a resposta do provedor como veio, para reenviar sem alterar
 * (o Claude exige que blocos de raciocínio voltem intactos nas chamadas seguintes).
 */
export type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown; provider?: string }
  | { role: "tool"; results: ToolResult[] };

/** Por que o modelo parou. "refusal" e "max_tokens" com ferramentas pendentes não devem executar ferramentas. */
export type StopKind = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface CompletionRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface Completion {
  text: string;
  toolCalls: ToolCall[];
  stop: StopKind;
  usage: Usage;
  raw?: unknown;
}

/** Falha do provedor já traduzida para o usuário. `kind` permite à interface sugerir a correção. */
export class ProviderError extends Error {
  constructor(
    readonly kind: "auth" | "rate_limit" | "overloaded" | "network" | "bad_request" | "aborted" | "other",
    message: string,
  ) {
    super(message);
  }
}

export interface LlmProvider {
  readonly id: string;
  readonly label: string;
  readonly models: ModelInfo[];
  readonly defaultModel: string;
  complete(request: CompletionRequest): Promise<Completion>;
}
