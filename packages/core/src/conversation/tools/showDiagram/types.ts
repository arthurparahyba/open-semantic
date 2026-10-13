// A entrada do show_diagram (o desenho que o modelo descreve) e o plano que sai dela.
import type { Block, DiagramModel } from "@open-semantic/protocol";

export const DIAGRAM_KINDS = ["layers", "sequence", "tree", "architecture", "flow", "dependency"] as const;

export interface ShowDiagramNode {
  id: string;
  label: string;
  kind?: string;
  /** Unidade de contexto que já existe (sem_...). */
  unit?: string;
  /** Pasta ou arquivo do projeto onde o agente viu isso. Com caminho, o nó vira conhecimento verificado. */
  path?: string;
  /** O que foi visto no caminho, em uma frase. */
  seen?: string;
  /** Faixa do nó num diagrama layers. */
  layer?: string;
}

export interface ShowDiagramEdge {
  from: string;
  to: string;
  label?: string;
  type?: string;
  /** A ligação aparece no código do caminho do nó de origem. */
  seen?: boolean;
  /** Posição da mensagem num diagrama sequence (1, 2, 3...). */
  order?: number;
  /** Mensagem de retorno num diagrama sequence. */
  reply?: boolean;
}

export interface ShowDiagramInput {
  diagramId: string;
  title: string;
  kind: DiagramModel["kind"];
  caption: string;
  projectId?: string;
  about?: string;
  direction?: "LR" | "TB";
  nodes: ShowDiagramNode[];
  edges?: ShowDiagramEdge[];
  remove?: string[];
  /** Título da seção, acima do diagrama (doc 13). */
  heading?: string;
  /** Texto de introdução, acima do diagrama, junto do título. */
  intro?: string;
  /** Notas embaixo do diagrama: texto, lista ou tabela. */
  notes?: SectionNote[];
  /** Diagrama ou bloco que este continua (fica embaixo). */
  continues?: string;
  /** Diagrama ou bloco que este aprofunda (fica à direita). */
  details?: string;
}

export type SectionNote = Pick<Block, "title" | "text" | "items" | "ordered" | "columns" | "rows"> & { kind: "text" | "list" | "table" };

export interface BatchStepInput {
  id: string;
  operation: string;
  arguments: Record<string, unknown>;
  dependsOn?: string[];
}

export interface ResolvedPath {
  artifactId: string;
  kind: "directory" | "file" | "process";
}

export interface ShowDiagramPlan {
  intent: string;
  steps: BatchStepInput[];
  /** Para o modelo: a unidade e o status de cada nó, e os caminhos que não existiam. */
  nodes: Record<string, { unit: string; knowledge: "verified" | "inferred" }>;
  notes: string[];
}

/** Nó e aresta como vão para o diagrama. */
export interface PlannedNode {
  id: string;
  label: string;
  kind: string;
  semanticEntityId: string;
  attributes?: Record<string, unknown>;
}

export interface PlannedEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string;
  semanticRelationId?: string;
  attributes?: Record<string, unknown>;
}
