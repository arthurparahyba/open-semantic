/**
 * Tira os tokens de confirmação vencidos há mais de `graceMs`. Até lá, usar um token vencido ainda
 * responde CONFIRMATION_EXPIRED em vez de "token não corresponde".
 */
export function pruneExpired(tokens: Map<string, { expiresAt: number }>, now: number, graceMs: number): void {
  for (const [token, pending] of tokens) if (pending.expiresAt + graceMs < now) tokens.delete(token);
}
