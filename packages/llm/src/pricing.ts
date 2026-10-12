import type { Pricing, Usage } from "./types.js";

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** Tamanho total do prompt de uma chamada: a parte nova mais o que veio do cache. */
export function promptTokens(usage: Usage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** Custo em dólares de UMA chamada (a faixa de preço depende do tamanho do prompt daquela chamada). */
export function costOf(usage: Usage, pricing: Pricing): number {
  const tier = pricing.longContext && promptTokens(usage) > pricing.longContext.aboveInputTokens ? pricing.longContext : pricing;
  return (
    (usage.inputTokens * tier.input +
      usage.outputTokens * tier.output +
      usage.cacheReadTokens * tier.cacheRead +
      usage.cacheWriteTokens * tier.cacheWrite) /
    1_000_000
  );
}
