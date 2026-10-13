// Como o store descobre o que uma transação mudou e como desfaz quando ela falha.
// Regra que sustenta tudo: um objeto que entrou no store nunca muda; quem altera grava uma cópia nova
// (os objetos ficam congelados para um descuido virar erro na hora).
import { sameValue, type WorkspaceSnapshot } from "@open-semantic/protocol";

import { COLLECTIONS, LISTS, isList, type Collection, type CollectionItems, type ListCollection, type StoreChange } from "./commits.js";

type Item = { id: string };

/** O estado de uma coleção antes da transação: a lista (cópia rasa) ou o objeto. */
export type Captured = Item[] | object;

export function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/** Congela todos os objetos do documento. Os contêineres (o documento, `semantic`, `canvas` e as listas) continuam mutáveis. */
export function freezeDocument(doc: WorkspaceSnapshot) {
  deepFreeze(doc.workspace);
  deepFreeze(doc.navigation);
  for (const collection of COLLECTIONS) if (isList(collection)) for (const item of LISTS[collection].get(doc)) deepFreeze(item);
}

export function capture(doc: WorkspaceSnapshot, collection: Collection): Captured {
  return isList(collection) ? (LISTS[collection].get(doc) as Item[]).slice() : doc[collection];
}

export function restore(doc: WorkspaceSnapshot, collection: Collection, before: Captured) {
  if (isList(collection)) (LISTS[collection].set as (d: WorkspaceSnapshot, items: Item[]) => void)(doc, before as Item[]);
  else if (collection === "workspace") doc.workspace = before as CollectionItems["workspace"];
  else doc.navigation = before as CollectionItems["navigation"];
}

/**
 * O que mudou numa coleção desde `before`. Um objeto trocado por outro igual não conta como mudança:
 * o original volta para o lugar, e quem guardou a referência continua com o objeto do store.
 */
export function diff(doc: WorkspaceSnapshot, collection: Collection, before: Captured): StoreChange[] {
  if (isList(collection)) return diffList(doc, collection, before as Item[]);
  const after = doc[collection];
  if (after === before) return [];
  if (sameValue(after, before)) {
    restore(doc, collection, before);
    return [];
  }
  return [{ collection, id: doc.workspace.id, kind: "updated", before, after } as StoreChange];
}

function diffList(doc: WorkspaceSnapshot, collection: ListCollection, before: Item[]): StoreChange[] {
  const current = LISTS[collection].get(doc) as Item[];
  const previous = new Map(before.map((item) => [item.id, item]));
  const changes: StoreChange[] = [];
  const present = new Set<string>();
  current.forEach((item, i) => {
    present.add(item.id);
    const old = previous.get(item.id);
    if (old === item) return;
    if (!old) changes.push({ collection, id: item.id, kind: "created", after: item } as StoreChange);
    else if (sameValue(old, item)) current[i] = old;
    else changes.push({ collection, id: item.id, kind: "updated", before: old, after: item } as StoreChange);
  });
  for (const old of before) if (!present.has(old.id)) changes.push({ collection, id: old.id, kind: "deleted", before: old } as StoreChange);
  return changes;
}
