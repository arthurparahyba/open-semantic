// A entrada do show_diagram (o desenho que o modelo descreve) e o plano que sai dela.
import type { DiagramModel } from "@open-semantic/protocol";

export const DIAGRAM_KINDS = ["architecture", "flow", "sequence", "dependency"] as const;

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
}

export interface ShowDiagramEdge {
  from: string;
  to: string;
  label?: string;
  type?: string;
  /** A ligação aparece no código do caminho do nó de origem. */
  seen?: boolean;
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
}

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
}

export interface PlannedEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string;
  semanticRelationId: string;
}
