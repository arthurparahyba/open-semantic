// Orçamento de um pedido: chamadas ao modelo, tokens, custo, lotes e passos, cada um com o seu teto.
import { ZERO_USAGE, addUsage, promptTokens, type Usage } from "@open-semantic/llm";

/** Tetos de cada pedido do usuário. Protegem a conta de laços longos ou caros. */
export interface TurnLimits {
  /** Chamadas ao modelo por pedido. */
  maxModelCalls: number;
  /** Lotes de mudanças por pedido. */
  maxBatches: number;
  /** Passos somados de todos os lotes do pedido. */
  maxSteps: number;
  /** Tokens somados (prompt + resposta) de todas as chamadas do pedido. */
  maxTokens: number;
  /** Tamanho máximo de cada resposta do modelo. */
  maxOutputTokens: number;
  /**
   * Quando o prompt de uma chamada passa disto, os pedidos anteriores são compactados antes do próximo.
   * A meta é 40 mil por chamada (spec 08); o Haiku cobra mais acima de 100 mil.
   */
  compactAboveTokens: number;
}

export const DEFAULT_LIMITS: TurnLimits = {
  maxModelCalls: 12,
  maxBatches: 6,
  maxSteps: 60,
  maxTokens: 600_000,
  maxOutputTokens: 8_000,
  compactAboveTokens: 40_000,
};

/** O que um pedido gastou até agora. */
export interface TurnSpend {
  usage: Usage;
  costUsd: number;
  modelCalls: number;
}

export class TurnBudget {
  private usage: Usage = ZERO_USAGE;
  private costUsd = 0;
  private modelCalls = 0;
  private batches = 0;
  private steps = 0;

  constructor(
    private readonly limits: TurnLimits,
    /** Teto de custo do pedido, das configurações do agente. */
    private readonly maxCostUsd: number,
  ) {}

  spend(): TurnSpend {
    return { usage: this.usage, costUsd: this.costUsd, modelCalls: this.modelCalls };
  }

  /** Algum lote rodou no pedido (quem já mexeu no canvas não é cobrado de desenhar). */
  get ranBatch(): boolean {
    return this.batches > 0;
  }

  /** A próxima chamada é a última que o limite de chamadas deixa. */
  get lastCall(): boolean {
    return this.modelCalls === this.limits.maxModelCalls - 1;
  }

  /** Uma chamada ao modelo. */
  record(usage: Usage, costUsd: number) {
    this.usage = addUsage(this.usage, usage);
    this.costUsd += costUsd;
    this.modelCalls += 1;
  }

  /** Por que parar antes da próxima chamada ao modelo, ou undefined para seguir. */
  stopReason(): string | undefined {
    const { maxModelCalls, maxTokens } = this.limits;
    const more = "Peça para continuar se quiser.";
    if (this.modelCalls >= maxModelCalls) return `Parei: este pedido chegou ao limite de ${maxModelCalls} chamadas ao modelo. ${more}`;
    if (promptTokens(this.usage) + this.usage.outputTokens >= maxTokens) {
      return `Parei: este pedido chegou ao limite de ${maxTokens.toLocaleString("pt-BR")} tokens. ${more}`;
    }
    if (this.costUsd >= this.maxCostUsd) return `Parei: este pedido chegou ao teto de custo de US$ ${this.maxCostUsd.toFixed(2)}. ${more}`;
    return undefined;
  }

  /** Reserva um lote de `steps` passos. Passar de um teto é erro, com a mensagem que volta ao modelo. */
  reserveBatch(steps: number) {
    const { maxBatches, maxSteps } = this.limits;
    if (this.batches >= maxBatches) throw new Error(`Limite de ${maxBatches} lotes por pedido atingido. Responda ao usuário com o que já foi feito.`);
    if (this.steps + steps > maxSteps) throw new Error(`Limite de ${maxSteps} passos por pedido: restam ${maxSteps - this.steps}. Divida ou reduza o lote.`);
    this.batches += 1;
    this.steps += steps;
  }
}
