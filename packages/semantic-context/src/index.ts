// Motor de contexto semântico: pacote próprio, sem depender de nenhum outro pacote do app.
export { SemanticContextEngine, DEFAULT_BUDGET, type AnalyzeInput, type BuildContextInput, type SearchResult } from "./engine.js";
export { DEFAULT_SYNONYMS, estimateTokens, sentences, terms } from "./text.js";
export type * from "./types.js";
