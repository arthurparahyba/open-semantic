// Ids e tipos do que o show_diagram registra: o texto livre do modelo vira id legível e tipo do contrato.
import type { DiagramModel } from "@open-semantic/protocol";

import { hash } from "../../text.js";

const ENTITY_KINDS = new Set([
  "repository",
  "application",
  "module",
  "service",
  "component",
  "api",
  "endpoint",
  "data_store",
  "file",
  "directory",
  "process",
  "concept",
  "decision",
  "requirement",
]);
const RELATION_TYPES = new Set([
  "contains",
  "implements",
  "depends_on",
  "calls",
  "communicates_with",
  "reads",
  "writes",
  "exposes",
  "tests",
  "documents",
  "decided_by",
  "represents",
]);
const KIND_ALIASES: Record<string, string> = {
  database: "data_store",
  db: "data_store",
  store: "data_store",
  table: "data_store",
  controller: "component",
  repository_class: "component",
  class: "component",
  package: "module",
  layer: "module",
  app: "application",
  user: "x-actor",
  person: "x-actor",
  actor: "x-actor",
  external: "x-external",
  system: "x-external",
  queue: "x-queue",
};

/** Id com prefixo, dentro do limite de 64 caracteres depois do prefixo. */
export function idOf(prefix: string, ...parts: string[]): string {
  const body = parts.join("_");
  return `${prefix}_${body.length <= 60 ? body : `${body.slice(0, 51)}_${hash(body)}`}`;
}

export function entityKind(kind: string | undefined): string {
  const k = (kind ?? "component").toLowerCase().trim();
  if (ENTITY_KINDS.has(k)) return k;
  if (KIND_ALIASES[k]) return KIND_ALIASES[k]!;
  if (/^x-[a-z][a-z0-9_]*$/.test(k)) return k;
  const s = k.replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "");
  return s ? `x-${s}` : "component";
}

export function relationType(type: string | undefined, diagramKind: DiagramModel["kind"]): string {
  const t = (type ?? "").toLowerCase().trim();
  if (RELATION_TYPES.has(t) || /^x-[a-z][a-z0-9_]*$/.test(t)) return t;
  return diagramKind === "flow" || diagramKind === "sequence" ? "calls" : "depends_on";
}
