// Ponte entre o workspace e o Motor de contexto semântico (docs/funcionalidades/08-gestao-de-contexto.md).
// O motor não conhece o protocolo: aqui o workspace vira itens de busca (unidades, diagramas, nós, arestas,
// mods, regiões), as evidências viram conteúdo e o foco vira navigation.frame.
import type { Dispatcher, WorkspaceSnapshot } from "@open-semantic/protocol";
import {
  SemanticContextEngine,
  type AttentionPort,
  type Clarification,
  type ContentPort,
  type IndexDoc,
  type IndexUpdate,
  type Relevance,
  type TargetRef,
  type UnitLink,
} from "@open-semantic/semantic-context";
import { parentsOf, repositoryUnit, unitItems } from "@open-semantic/workspace-store";

/** Papel que o tipo da unidade sugere, para "o back-end" achar um serviço que não diz isso no nome. */
const ROLE_BY_KIND: Record<string, string> = {
  service: "backend",
  api: "backend",
  endpoint: "backend",
  data_store: "banco de dados",
};

/** O workspace inteiro como itens do índice. O motor ignora o que não mudou, então pode ser chamado a cada pedido. */
export function workspaceIndex(snapshot: WorkspaceSnapshot): IndexUpdate {
  const docs: IndexDoc[] = [];
  const links: UnitLink[] = [];
  const entities = new Map(snapshot.semantic.entities.map((e) => [e.id, e]));
  const repoOf = (projectId: string | undefined) => (projectId ? repositoryUnit(snapshot, projectId)?.id : undefined);

  for (const e of snapshot.semantic.entities) {
    const attrs = e.attributes ?? {};
    const role = [attrs.role, attrs.layer].filter((v): v is string => typeof v === "string");
    docs.push({
      id: e.id,
      kind: "unit",
      name: e.name,
      unitIds: [e.id],
      unitKind: e.kind,
      extra: [e.kind === "repository" ? "repository repositorio" : e.kind, ROLE_BY_KIND[e.kind], ...role].filter(Boolean).join(" "),
      status: e.status,
      ...(e.aliases?.length ? { aliases: e.aliases } : {}),
      ...(e.description ? { description: e.description } : {}),
      ...(e.projectId ? { projectId: e.projectId } : {}),
    });
  }
  // `contains` explícito ou implícito (a unidade fica dentro do repositório dela), como no canvas.
  for (const [child, parent] of parentsOf(snapshot)) links.push({ from: parent, to: child, type: "contains" });
  for (const r of snapshot.semantic.relations) {
    if (r.type === "contains" || r.status === "rejected" || r.status === "invalid") continue;
    if (entities.has(r.sourceId) && entities.has(r.targetId)) links.push({ from: r.sourceId, to: r.targetId, type: r.type });
  }

  for (const d of snapshot.diagrams) {
    const anchors = d.anchorIds?.filter((id) => entities.has(id)) ?? [];
    const unitIds = anchors.length ? anchors : [repoOf(d.projectId)].filter((id): id is string => !!id);
    docs.push({ id: d.id, kind: "diagram", name: d.title, unitIds, diagramKind: d.kind, extra: d.kind, ...(d.projectId ? { projectId: d.projectId } : {}) });
    for (const n of d.nodes) {
      const unit = n.semanticEntityId && entities.has(n.semanticEntityId) ? [n.semanticEntityId] : unitIds;
      docs.push({ id: n.id, kind: "node", name: n.label, unitIds: unit, diagramId: d.id, diagramKind: d.kind, extra: n.kind });
    }
    for (const e of d.edges) {
      docs.push({ id: e.id, kind: "edge", name: e.label ?? "", unitIds, diagramId: d.id, diagramKind: d.kind, sourceId: e.sourceNodeId, targetId: e.targetNodeId });
    }
  }
  for (const m of snapshot.mods) {
    const anchors = m.semanticEntityIds?.filter((id) => entities.has(id)) ?? [];
    const unitIds = anchors.length ? anchors : [repoOf(m.projectId)].filter((id): id is string => !!id);
    docs.push({ id: m.id, kind: "mod", name: m.title ?? m.type, unitIds, extra: m.type, ...(m.projectId ? { projectId: m.projectId } : {}) });
  }
  for (const r of snapshot.canvas.regions) {
    docs.push({ id: r.id, kind: "region", name: r.title, unitIds: r.semanticEntityIds?.filter((id) => entities.has(id)) ?? [] });
  }
  return { upsert: docs, links };
}

/** Motor de contexto ligado a um workspace: sincroniza o índice, lê evidências e leva o foco ao canvas. */
export class WorkspaceContext {
  readonly engine = new SemanticContextEngine();

  constructor(private readonly snapshot: () => WorkspaceSnapshot) {}

  /** Põe o índice em dia com o workspace (o que não mudou não é reindexado). */
  sync(): WorkspaceSnapshot {
    const snapshot = this.snapshot();
    const update = workspaceIndex(snapshot);
    const present = new Set(update.upsert!.map((d) => d.id));
    this.engine.feed({ ...update, remove: this.engine.ids().filter((id) => !present.has(id)) });
    return snapshot;
  }

  /** Conteúdo além do índice: descrição e evidências atuais de uma unidade. */
  content(snapshot: WorkspaceSnapshot): ContentPort {
    const evidence = new Map(snapshot.semantic.evidence.map((e) => [e.id, e]));
    return {
      read: async (ref, level) => {
        const entity = snapshot.semantic.entities.find((e) => e.id === ref);
        if (!entity || level < 1) return undefined;
        const summaries = (entity.provenance.evidenceIds ?? [])
          .map((id) => evidence.get(id))
          .filter((e) => e && e.status === "current")
          .map((e) => e!.summary)
          .slice(0, level >= 2 ? 6 : 2);
        if (entity.status === "inferred" && entity.provenance.rationale) summaries.push(`Suposição: ${entity.provenance.rationale}`);
        return summaries.length ? summaries.join(" ") : undefined;
      },
    };
  }
}

/**
 * Foco no canvas pelo protocolo, assinado pelo agente: respeita o usuário mexendo na câmera (vira sugestão)
 * e fica no histórico de ações. Só enquadra o que está no canvas; o resto fica para a resposta.
 */
export function canvasAttention(options: {
  dispatcher: Dispatcher;
  snapshot(): WorkspaceSnapshot;
  actor: { kind: "agent"; id: string };
  newId(): string;
  ask(question: Clarification): Promise<TargetRef | undefined>;
}): AttentionPort {
  return {
    ask: options.ask,
    async focus(target, emphasis, reason) {
      const snapshot = options.snapshot();
      const onCanvas = new Set(snapshot.canvas.objects.map((o) => o.id));
      const visible = new Set<string>(onCanvas);
      for (const d of snapshot.diagrams) {
        if (!onCanvas.has(d.id)) continue;
        for (const n of d.nodes) visible.add(n.id);
        for (const e of d.edges) visible.add(e.id);
      }
      const primary = emphasis.filter((e) => e.level === "primary" && visible.has(e.ref)).map((e) => e.ref);
      // Uma unidade só tem para onde ir se algo dela está desenhado; sem isso o foco fica para a resposta.
      const drawn = (unit: string) =>
        unitItems(snapshot, unit).length > 0 || snapshot.diagrams.some((d) => onCanvas.has(d.id) && d.nodes.some((n) => n.semanticEntityId === unit));
      const targets = visible.has(target)
        ? { visualIds: [...new Set([target, ...primary])] }
        : target.startsWith("sem_") && drawn(target)
          ? { semanticEntityIds: [target] }
          : undefined;
      if (!targets) return;
      await options.dispatcher.dispatch({
        operationId: `act_${options.newId()}`,
        operation: "navigation.frame",
        arguments: { targets, intent: "focus", highlight: true, reason: reason.slice(0, 200) },
        authorization: { actor: options.actor },
      });
    },
  };
}

/** Texto curto do assunto para o motivo do foco ("Assunto: api-contas"). */
export function topicReason(relevance: Relevance, engine: SemanticContextEngine): string {
  const main = relevance.topics[0];
  const names = (main?.unitIds ?? []).slice(0, 3).map((id) => engine.doc(id)?.name ?? id);
  return names.length ? `Assunto: ${names.join(", ")}` : "Assunto da mensagem";
}
