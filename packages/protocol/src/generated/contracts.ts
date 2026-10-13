/* Gerado por scripts/gen-types.mjs a partir de contracts/schemas. Não edite à mão: rode `pnpm gen:types`. */

/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "WorkspaceId".
 */
export type WorkspaceId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "ProjectId".
 */
export type ProjectId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "RootId".
 */
export type RootId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "ModId".
 */
export type ModId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "DiagramId".
 */
export type DiagramId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "NodeId".
 */
export type NodeId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "EdgeId".
 */
export type EdgeId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "SemanticEntityId".
 */
export type SemanticEntityId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "RelationId".
 */
export type RelationId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "EvidenceId".
 */
export type EvidenceId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "ArtifactId".
 */
export type ArtifactId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "RegionId".
 */
export type RegionId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "OperationId".
 */
export type OperationId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "BatchId".
 */
export type BatchId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "EventId".
 */
export type EventId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "NavigationId".
 */
export type NavigationId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "TurnId".
 */
export type TurnId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "GrantId".
 */
export type GrantId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "LayerId".
 */
export type LayerId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "StepId".
 */
export type StepId = string;
/**
 * Um objeto do canvas tem o mesmo id do mod ou diagrama que ele posiciona.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "CanvasObjectId".
 */
export type CanvasObjectId = ModId | DiagramId;
/**
 * Qualquer coisa que o Semantic Navigator pode enquadrar ou destacar. Uma unidade de contexto (sem_) vale pelo grupo desenhado em volta dela.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "VisualTargetId".
 */
export type VisualTargetId = ModId | DiagramId | NodeId | EdgeId | RegionId | SemanticEntityId;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "AnyId".
 */
export type AnyId = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Timestamp".
 */
export type Timestamp = string;
/**
 * Contador monotônico por objeto, usado para concorrência otimista e pré-condições.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Revision".
 */
export type Revision = number;
/**
 * Caminho relativo à raiz autorizada, com '/' como separador. Nunca absoluto, nunca com segmentos '..'. String vazia significa a própria raiz.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "ProjectRelativePath".
 */
export type ProjectRelativePath = string;
/**
 * Capacidades de acesso ao projeto real. São independentes entre si (V0.1 §6).
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Capability".
 */
export type Capability = "read" | "write" | "delete" | "execute";
/**
 * Qualidade do conhecimento de uma entidade ou relação semântica. Ver maquina-de-estados.md §6.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "KnowledgeStatus".
 */
export type KnowledgeStatus = "verified" | "inferred" | "pending" | "stale" | "invalid" | "rejected";
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "ErrorCode".
 */
export type ErrorCode =
  | "INVALID_ARGUMENTS"
  | "UNKNOWN_OPERATION"
  | "TARGET_NOT_FOUND"
  | "PRECONDITION_FAILED"
  | "REVISION_CONFLICT"
  | "CAPABILITY_NOT_SUPPORTED"
  | "UNAUTHORIZED"
  | "CONFIRMATION_DECLINED"
  | "CONFIRMATION_EXPIRED"
  | "PATH_OUTSIDE_ROOT"
  | "REFERENCE_INVALID"
  | "EXTERNAL_CHANGE_CONFLICT"
  | "INVALID_STATE_TRANSITION"
  | "DEPENDENCY_FAILED"
  | "IDEMPOTENCY_MISMATCH"
  | "CANCELLED"
  | "TIMEOUT"
  | "INTERNAL";
/**
 * O que pode ser membro de uma camada: diagrama, nó, mod ou trecho de conversa (turno).
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "LayerMemberId".
 */
export type LayerMemberId = DiagramId | NodeId | ModId | TurnId;
/**
 * Camada mãe. Ausente: a filha nasce da base (o workspace).
 */
export type LayerId1 = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "ModType".
 */
export type ModType = ("explorer" | "editor" | "terminal" | "table") | string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "ModInstance".
 */
export type ModInstance = ModInstance1;
/**
 * Camada de assunto ativa. Ausente: a base (o workspace inteiro).
 */
export type LayerId2 = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "OperationName".
 */
export type OperationName = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Precondition".
 */
export type Precondition =
  | {
      kind: "revision_equals";
      targetId: AnyId;
      revision: Revision;
    }
  | {
      kind: "exists";
      targetId: AnyId;
    }
  | {
      kind: "not_exists";
      targetId: AnyId;
    }
  | {
      kind: "artifact_unchanged";
      artifactId: ArtifactId;
      fingerprint: Fingerprint;
    }
  | {
      kind: "mod_lifecycle";
      modId: ModId;
      lifecycle: "active" | "closed";
    };
/**
 * Gerado pelo solicitante. Também é a chave de idempotência: reenviar o mesmo operationId com os mesmos argumentos devolve o resultado original com replayed=true (uma leitura consulta de novo); com outros argumentos, IDEMPOTENCY_MISMATCH.
 */
export type OperationId1 = string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "OperationResult".
 */
export type OperationResult = OperationResult1;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "ProjectLocation".
 */
export type ProjectLocation =
  | {
      kind: "local";
      /**
       * Caminho absoluto no dispositivo. Visível apenas para o Project Runtime; nunca é enviado ao agente.
       */
      rootPath: string;
    }
  | {
      kind: "remote";
      /**
       * Reservado. Não implementado no MVP.
       */
      endpoint: string;
      rootPath?: string;
    };
/**
 * ArtifactReference do diretório raiz do projeto.
 */
export type ArtifactId1 = string;
/**
 * Identidade estável de um recurso real. O caminho pode mudar (rename) sem trocar o id.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "ArtifactReference".
 */
export type ArtifactReference = ArtifactReference1;
/**
 * Vocabulário inicial. Valores fora da lista são aceitos com prefixo 'x-' para extensão.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "EntityKind".
 */
export type EntityKind =
  | (
      | "repository"
      | "application"
      | "module"
      | "service"
      | "component"
      | "api"
      | "endpoint"
      | "data_store"
      | "file"
      | "directory"
      | "process"
      | "concept"
      | "decision"
      | "requirement"
    )
  | string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "RelationType".
 */
export type RelationType =
  | (
      | "contains"
      | "implements"
      | "depends_on"
      | "calls"
      | "communicates_with"
      | "reads"
      | "writes"
      | "exposes"
      | "tests"
      | "documents"
      | "decided_by"
      | "represents"
    )
  | string;
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "SemanticEntity".
 */
export type SemanticEntity = KnowledgeRules & SemanticEntity1;
/**
 * Regra central do Open Semantic: inferência do agente nunca é 'verified' sem evidência (V0.1 §3.4, critério C3).
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "KnowledgeRules".
 */
export type KnowledgeRules = {
  [k: string]: unknown | undefined;
};
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "SemanticRelation".
 */
export type SemanticRelation = KnowledgeRules & SemanticRelation1;
/**
 * Contador monotônico por objeto, usado para concorrência otimista e pré-condições.
 */
export type Revision1 = number;
/**
 * Projeto em que o agente trabalha quando o pedido não diz outro. É o último aberto pelo usuário.
 */
export type ProjectId1 = string;

export interface OpenSemanticContracts {}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Point".
 */
export interface Point {
  x: number;
  y: number;
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Size".
 */
export interface Size {
  width: number;
  height: number;
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Rect".
 */
export interface Rect {
  position: Point;
  size: Size;
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Actor".
 */
export interface Actor {
  kind: "user" | "agent" | "system";
  id: string;
}
/**
 * De onde veio uma informação. 'agent_inference' exige confidence; 'verified' só é alcançável com fontes que não sejam inferência.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Provenance".
 */
export interface Provenance {
  source: "inspection" | "execution" | "user_statement" | "agent_inference" | "diagram_edit" | "import";
  actor: Actor;
  operationId?: OperationId;
  turnId?: TurnId;
  evidenceIds?: EvidenceId[];
  confidence?: number;
  rationale?: string;
  recordedAt: Timestamp;
}
/**
 * Explicação estruturada de uma rejeição ou falha (V0.1 critério E1).
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Error".
 */
export interface Error {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  /**
   * JSON Pointer para o argumento inválido, quando houver, relativo a arguments ("/" é o objeto inteiro). Num lote fora do contrato, relativo ao plano. Um ponteiro fora dos argumentos vai em details.requestPath.
   */
  argumentPath?: string;
  targetId?: string;
  details?: {
    [k: string]: unknown | undefined;
  };
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "DiagramNode".
 */
export interface DiagramNode {
  id: NodeId;
  label: string;
  /**
   * Forma lógica: service, module, data_store, actor, note, group…
   */
  kind: string;
  semanticEntityId?: SemanticEntityId;
  parentNodeId?: NodeId;
  attributes?: {
    [k: string]: unknown | undefined;
  };
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "DiagramEdge".
 */
export interface DiagramEdge {
  id: EdgeId;
  sourceNodeId: NodeId;
  targetNodeId: NodeId;
  label?: string;
  kind?: string;
  semanticRelationId?: RelationId;
  attributes?: {
    [k: string]: unknown | undefined;
  };
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "DiagramLayout".
 */
export interface DiagramLayout {
  algorithm: "manual" | "layered" | "force" | "grid";
  direction?: "LR" | "RL" | "TB" | "BT";
  /**
   * Retângulo de cada nó, relativo ao canto superior esquerdo do diagrama.
   */
  nodes: {
    [k: string]: Rect | undefined;
  };
  /**
   * Nós movidos pelo usuário; relayout automático não os desloca.
   */
  pinned?: NodeId[];
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "DiagramModel".
 */
export interface DiagramModel {
  id: DiagramId;
  title: string;
  /**
   * Legenda curta que explica o diagrama, mostrada junto dele no canvas e no chat. O diagrama é a resposta; a legenda o acompanha.
   */
  caption?: string;
  kind: "architecture" | "flow" | "sequence" | "dependency" | "freeform";
  projectId?: ProjectId;
  /**
   * Unidades de contexto (entidades semânticas) sobre as quais o diagrama fala. O lugar dele no canvas sai daqui (ver docs/funcionalidades/09).
   *
   * @minItems 1
   */
  anchorIds?: [SemanticEntityId, ...SemanticEntityId[]];
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  layout: DiagramLayout;
  revision: Revision;
}
/**
 * Argumento de diagram.apply_patch. Ops aplicadas em ordem; ids novos são escolhidos pelo cliente para tornar a operação idempotente.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "DiagramPatch".
 */
export interface DiagramPatch {
  /**
   * @minItems 1
   */
  ops: [
    (
      | {
          op: "add_node";
          node: DiagramNode;
        }
      | {
          op: "update_node";
          nodeId: NodeId;
          set: {
            [k: string]: unknown | undefined;
          };
        }
      | {
          op: "remove_node";
          nodeId: NodeId;
        }
      | {
          op: "add_edge";
          edge: DiagramEdge;
        }
      | {
          op: "update_edge";
          edgeId: EdgeId;
          set: {
            [k: string]: unknown | undefined;
          };
        }
      | {
          op: "remove_edge";
          edgeId: EdgeId;
        }
      | {
          op: "bind_node";
          nodeId: NodeId;
          semanticEntityId: SemanticEntityId;
        }
    ),
    ...(
      | {
          op: "add_node";
          node: DiagramNode;
        }
      | {
          op: "update_node";
          nodeId: NodeId;
          set: {
            [k: string]: unknown | undefined;
          };
        }
      | {
          op: "remove_node";
          nodeId: NodeId;
        }
      | {
          op: "add_edge";
          edge: DiagramEdge;
        }
      | {
          op: "update_edge";
          edgeId: EdgeId;
          set: {
            [k: string]: unknown | undefined;
          };
        }
      | {
          op: "remove_edge";
          edgeId: EdgeId;
        }
      | {
          op: "bind_node";
          nodeId: NodeId;
          semanticEntityId: SemanticEntityId;
        }
    )[]
  ];
  relayout?: boolean;
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "LayerMember".
 */
export interface LayerMember {
  id: LayerMemberId;
  /**
   * Pertinência ao assunto. Peso baixo aparece esmaecido, não some.
   */
  weight: number;
  reason?: string;
  /**
   * Membros que o usuário pôs ou tirou o agente não desfaz.
   */
  addedBy: "agent" | "user";
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Layer".
 */
export interface Layer {
  id: LayerId;
  name: string;
  description?: string;
  parentId?: LayerId1;
  /**
   * Elementos da camada de baixo de onde a camada nasceu. Normalmente um; uma camada de integração pode ter um por aplicação.
   */
  anchors: LayerMemberId[];
  members: LayerMember[];
  origin: "agent" | "user";
  createdAt: Timestamp;
  lastActiveAt: Timestamp;
  revision?: Revision;
}
/**
 * Uma ação que o tipo de mod expõe via mod.invoke.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "CapabilityDescriptor".
 */
export interface CapabilityDescriptor {
  name: string;
  description?: string;
  /**
   * Capacidades de projeto exigidas na raiz alvo.
   */
  requires: Capability[];
  idempotent: boolean;
  confirmation: "never" | "policy" | "always";
  /**
   * JSON Schema do input.
   */
  inputSchema?: {
    [k: string]: unknown | undefined;
  };
  /**
   * JSON Schema do output.
   */
  outputSchema?: {
    [k: string]: unknown | undefined;
  };
}
/**
 * Resposta de mod.list_types: o que cada tipo declara sobre si (critério B5).
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "ModTypeDescriptor".
 */
export interface ModTypeDescriptor {
  type: ModType;
  version: number;
  title: string;
  defaultSize?: Size;
  capabilities: CapabilityDescriptor[];
  configSchema: {
    [k: string]: unknown | undefined;
  };
  uiStateSchema?: {
    [k: string]: unknown | undefined;
  };
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "ExplorerConfig".
 */
export interface ExplorerConfig {
  rootRef: ArtifactId;
  showHidden?: boolean;
  exclude?: string[];
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "ExplorerUiState".
 */
export interface ExplorerUiState {
  currentDirRef?: ArtifactId;
  expanded?: ArtifactId[];
  selected?: ArtifactId[];
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "EditorConfig".
 */
export interface EditorConfig {
  fileRef: ArtifactId;
  readOnly?: boolean;
  encoding?: string;
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "TerminalConfig".
 */
export interface TerminalConfig {
  cwdRef: ArtifactId;
  keepHistory?: number;
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "TableConfig".
 */
export interface TableConfig {
  source:
    | {
        kind: "inline";
        rows: {
          [k: string]: unknown | undefined;
        }[];
      }
    | {
        kind: "file";
        fileRef: ArtifactId;
        format: "csv" | "json";
      }
    | {
        kind: "operation_result";
        operationId: OperationId;
        pointer?: string;
      };
  columns?: {
    key: string;
    label?: string;
    type?: "string" | "number" | "boolean" | "date";
  }[];
  editable?: boolean;
}
export interface ModInstance1 {
  id: ModId;
  type: ModType;
  typeVersion: number;
  projectId?: ProjectId;
  title?: string;
  config: {
    [k: string]: unknown | undefined;
  };
  uiState?: {
    [k: string]: unknown | undefined;
  };
  /**
   * Entidades que este mod representa (por exemplo, o módulo 'backend').
   */
  semanticEntityIds?: SemanticEntityId[];
  /**
   * Somente estados persistidos. 'deleted' não aparece: instâncias excluídas saem do snapshot e ficam no ActionRecord.
   */
  lifecycle: "active" | "closed";
  revision: Revision;
  createdBy: Actor;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}
/**
 * Estado operacional, NUNCA persistido no workspace. Recalculado ao abrir.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "ModRuntimeState".
 */
export interface ModRuntimeState {
  modId: ModId;
  status: "unloaded" | "loading" | "ready" | "degraded" | "error" | "suspended";
  error?: Error;
  /**
   * Editor/Tabela com alterações não salvas.
   */
  dirty?: boolean;
  /**
   * Editor detectou mudança externa.
   */
  conflict?: boolean;
  process?: {
    artifactId?: ArtifactId;
    status?: "running" | "exited" | "killed";
    exitCode?: number;
  };
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Camera".
 */
export interface Camera {
  center: Point;
  zoom: number;
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Focus".
 */
export interface Focus {
  regionId?: RegionId;
  targetIds?: VisualTargetId[];
  highlightIds?: VisualTargetId[];
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "HistoryEntry".
 */
export interface HistoryEntry {
  camera: Camera;
  focus?: Focus;
  origin: "agent" | "user";
  at: Timestamp;
}
/**
 * Estado recuperável (V0.1 §2.1). 'motion' é transitório e volta a 'idle' ao reabrir.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "NavigationState".
 */
export interface NavigationState {
  camera: Camera;
  focus: Focus;
  lastOverview?: Camera;
  activeLayerId?: LayerId2;
  /**
   * @maxItems 20
   */
  history:
    | []
    | [HistoryEntry]
    | [HistoryEntry, HistoryEntry]
    | [HistoryEntry, HistoryEntry, HistoryEntry]
    | [HistoryEntry, HistoryEntry, HistoryEntry, HistoryEntry]
    | [HistoryEntry, HistoryEntry, HistoryEntry, HistoryEntry, HistoryEntry]
    | [HistoryEntry, HistoryEntry, HistoryEntry, HistoryEntry, HistoryEntry, HistoryEntry]
    | [HistoryEntry, HistoryEntry, HistoryEntry, HistoryEntry, HistoryEntry, HistoryEntry, HistoryEntry]
    | [
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry
      ]
    | [
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry
      ]
    | [
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry
      ]
    | [
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry
      ]
    | [
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry
      ]
    | [
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry
      ]
    | [
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry
      ]
    | [
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry
      ]
    | [
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry
      ]
    | [
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry
      ]
    | [
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry
      ]
    | [
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry
      ]
    | [
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry,
        HistoryEntry
      ];
  motion: {
    status: "idle" | "animating" | "cancelled";
    navigationId?: NavigationId;
    origin?: "agent" | "user";
    target?: Camera;
    startedAt?: Timestamp;
  };
  control: {
    /**
     * 'shared': agente pode navegar. 'user_hold': usuário mexeu na câmera há pouco; pedidos do agente esperam ou viram sugestão. 'user_locked': usuário desligou navegação automática.
     */
    mode: "shared" | "user_hold" | "user_locked";
    holdUntil?: Timestamp;
  };
}
/**
 * Argumento de navigation.frame. O agente diz O QUE enquadrar; o Navigator calcula a geometria (V0.1 §5.2).
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "FrameRequest".
 */
export interface FrameRequest {
  targets: {
    /**
     * @minItems 1
     */
    visualIds?: [VisualTargetId, ...VisualTargetId[]];
    /**
     * @minItems 1
     */
    semanticEntityIds?: [SemanticEntityId, ...SemanticEntityId[]];
    regionId?: RegionId;
  };
  intent?: "overview" | "focus" | "detail" | "compare";
  highlight?: boolean;
  padding?: number;
  animate?: boolean;
  /**
   * Texto curto exibido ao usuário durante o movimento.
   */
  reason?: string;
}
/**
 * Impressão usada para detectar mudança externa. contentHash é obrigatório para arquivos abertos em Editor.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Fingerprint".
 */
export interface Fingerprint {
  mtime?: Timestamp;
  size?: number;
  contentHash?: string;
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Authorization".
 */
export interface Authorization {
  actor: Actor;
  onBehalfOf?: Actor;
  grantIds?: GrantId[];
  /**
   * Devolvido pelo runtime num resultado 'confirmation_required' e reenviado depois que o usuário aprova.
   */
  confirmationToken?: string;
}
/**
 * Dentro de um lote, qualquer valor de 'arguments' ou 'targetId' pode ser {"$bind": {...}} e é substituído pela saída de um passo anterior antes da validação.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "StepBinding".
 */
export interface StepBinding {
  $bind: {
    step: StepId;
    pointer: string;
  };
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "OperationRequest".
 */
export interface OperationRequest {
  operationId: OperationId1;
  operation: OperationName;
  targetId?: AnyId | StepBinding;
  arguments: {
    [k: string]: unknown | undefined;
  };
  preconditions?: Precondition[];
  authorization: Authorization;
  dryRun?: boolean;
  turnId?: TurnId;
  batchId?: BatchId;
  stepId?: StepId;
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Change".
 */
export interface Change {
  id: AnyId;
  change: "created" | "updated" | "deleted" | "unchanged";
  revision?: Revision;
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "ConfirmationRequest".
 */
export interface ConfirmationRequest {
  token: string;
  risk: "low" | "medium" | "high" | "irreversible";
  /**
   * Frase exibida ao usuário: o que vai acontecer.
   */
  summary: string;
  reversible?: boolean;
  expiresAt: Timestamp;
}
export interface OperationResult1 {
  operationId: OperationId;
  /**
   * rejected = não passou na validação (nada mudou). failed = começou a executar e falhou (ver changes para efeitos parciais). skipped = não executada porque uma dependência do lote falhou.
   */
  status: "succeeded" | "rejected" | "failed" | "confirmation_required" | "cancelled" | "skipped";
  output?: {
    [k: string]: unknown | undefined;
  };
  changes?: Change[];
  error?: Error;
  confirmation?: ConfirmationRequest;
  replayed?: boolean;
  workspaceRevision?: Revision;
  eventIds?: EventId[];
  completedAt: Timestamp;
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "BatchStep".
 */
export interface BatchStep {
  stepId: StepId;
  dependsOn?: StepId[];
  request: OperationRequest;
}
/**
 * Um plano coerente para uma intenção do usuário. As dependências formam um DAG (verificado por scripts/validar.py).
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "BatchPlan".
 */
export interface BatchPlan {
  batchId: BatchId;
  turnId?: TurnId;
  /**
   * Resumo da intenção, mostrado no histórico.
   */
  intent: string;
  /**
   * @minItems 1
   * @maxItems 50
   */
  steps: [BatchStep, ...BatchStep[]];
  policy: {
    onStepFailure?: "skip_dependents" | "abort_batch";
    /**
     * Valida todos os passos sem bindings pendentes antes de executar qualquer um.
     */
    validateFirst?: boolean;
    confirmation?: "per_step" | "upfront";
  };
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "BatchResult".
 */
export interface BatchResult {
  batchId: BatchId;
  status:
    | "validating"
    | "awaiting_confirmation"
    | "running"
    | "completed"
    | "partially_completed"
    | "failed"
    | "rejected"
    | "cancelled";
  steps: {
    [k: string]: OperationResult | undefined;
  };
  pendingConfirmations?: StepId[];
  completedAt?: Timestamp;
}
/**
 * Histórico persistente (V0.1 critério E4). Um registro por operação executada ou rejeitada.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "ActionRecord".
 */
export interface ActionRecord {
  id: OperationId;
  operation: OperationName;
  targetId?: AnyId;
  actor: Actor;
  batchId?: BatchId;
  stepId?: StepId;
  turnId?: TurnId;
  /**
   * Argumentos sem conteúdo de arquivo ou segredos.
   */
  argumentsRedacted?: {
    [k: string]: unknown | undefined;
  };
  /**
   * rejected = não passou na validação (nada mudou). failed = começou a executar e falhou (ver changes para efeitos parciais). skipped = não executada porque uma dependência do lote falhou.
   */
  status: "succeeded" | "rejected" | "failed" | "confirmation_required" | "cancelled" | "skipped";
  changes?: Change[];
  error?: Error;
  undo?: {
    kind: "none" | "inverse_operation" | "snapshot";
    inverse?: OperationRequest;
    snapshotRef?: string;
  };
  requestedAt: Timestamp;
  completedAt?: Timestamp;
}
/**
 * Eventos publicados pelos módulos. A interface e o agente reagem a eventos; nunca leem estado interno uns dos outros.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "DomainEvent".
 */
export interface DomainEvent {
  eventId: EventId;
  type:
    | "workspace.opened"
    | "workspace.revision_changed"
    | "canvas.object_moved"
    | "region.changed"
    | "layer.changed"
    | "mod.created"
    | "mod.configured"
    | "mod.lifecycle_changed"
    | "mod.deleted"
    | "mod.runtime_state_changed"
    | "diagram.created"
    | "diagram.changed"
    | "diagram.deleted"
    | "semantic.entity_upserted"
    | "semantic.relation_upserted"
    | "semantic.status_changed"
    | "artifact.created"
    | "artifact.changed"
    | "artifact.missing"
    | "artifact.validity_changed"
    | "editor.conflict_detected"
    | "process.output"
    | "process.exited"
    | "navigation.started"
    | "navigation.completed"
    | "navigation.cancelled"
    | "navigation.user_interacted"
    | "operation.completed"
    | "batch.status_changed";
  source:
    | "workspace_store"
    | "mod_runtime"
    | "diagram_engine"
    | "semantic"
    | "navigator"
    | "project_runtime"
    | "orchestrator"
    | "ui";
  subjectId?: AnyId;
  operationId?: OperationId;
  workspaceRevision?: Revision;
  payload?: {
    [k: string]: unknown | undefined;
  };
  at: Timestamp;
}
/**
 * Uma subárvore do projeto em que o runtime aceita operações, com as capacidades concedidas.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "AuthorizedRoot".
 */
export interface AuthorizedRoot {
  id: RootId;
  path: ProjectRelativePath;
  /**
   * @minItems 1
   */
  capabilities: [Capability, ...Capability[]];
  /**
   * Só relevante com 'execute'. Ver interfaces.md §6.4.
   */
  commandPolicy?: {
    mode?: "confirm_all" | "allowlist_then_confirm" | "deny_all";
    allowlist?: string[];
  };
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Project".
 */
export interface Project {
  id: ProjectId;
  name: string;
  location: ProjectLocation;
  /**
   * @minItems 1
   */
  roots: [AuthorizedRoot, ...AuthorizedRoot[]];
  rootRef: ArtifactId1;
  revision: Revision;
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "ArtifactValidity".
 */
export interface ArtifactValidity {
  status: "unknown" | "valid" | "changed" | "missing" | "inaccessible" | "outside_root";
  checkedAt: Timestamp;
  fingerprint?: Fingerprint;
  reason?: string;
}
export interface ArtifactReference1 {
  id: ArtifactId;
  projectId: ProjectId;
  kind: "directory" | "file" | "process";
  locator:
    | {
        rootId: RootId;
        path: ProjectRelativePath;
      }
    | {
        /**
         * Identificador do processo atribuído pelo Project Runtime.
         */
        processKey: string;
        commandLine?: string;
        cwdArtifactId?: ArtifactId;
      };
  validity: ArtifactValidity;
  provenance: Provenance;
}
/**
 * Uma observação concreta que sustenta entidades ou relações. Evidências são imutáveis; quando o artefato muda, a evidência fica stale, não é editada.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Evidence".
 */
export interface Evidence {
  id: EvidenceId;
  kind:
    | "file_inspection"
    | "directory_listing"
    | "command_execution"
    | "user_statement"
    | "agent_reasoning"
    | "diagram_edit";
  artifactId?: ArtifactId;
  span?: {
    lineStart: number;
    lineEnd: number;
  };
  artifactFingerprint?: Fingerprint;
  operationId?: OperationId;
  turnId?: TurnId;
  summary: string;
  status: "current" | "stale";
  observedAt: Timestamp;
}
export interface SemanticEntity1 {
  id: SemanticEntityId;
  kind: EntityKind;
  name: string;
  description?: string;
  aliases?: string[];
  projectId?: ProjectId;
  /**
   * Recursos reais que materializam a entidade. Um arquivo é uma entidade 'file' com exatamente um artifactId.
   */
  artifactIds?: ArtifactId[];
  attributes?: {
    [k: string]: unknown | undefined;
  };
  status: KnowledgeStatus;
  provenance: Provenance;
  revision: Revision;
}
export interface SemanticRelation1 {
  id: RelationId;
  type: RelationType;
  sourceId: SemanticEntityId;
  targetId: SemanticEntityId;
  attributes?: {
    [k: string]: unknown | undefined;
  };
  status: KnowledgeStatus;
  provenance: Provenance;
  revision: Revision;
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Workspace".
 */
export interface Workspace {
  id: WorkspaceId;
  name: string;
  revision: Revision1;
  activeProjectId?: ProjectId1;
  projectIds: ProjectId[];
  settings: {
    autoNavigate?: boolean;
    userHoldMs?: number;
    agentMayDeleteMods?: boolean;
  };
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "CanvasObject".
 */
export interface CanvasObject {
  id: CanvasObjectId;
  objectKind: "mod" | "diagram";
  position: Point;
  size: Size;
  zIndex?: number;
  regionId?: RegionId;
  collapsed?: boolean;
  /**
   * Objetos colocados pelo usuário não são reposicionados automaticamente.
   */
  placedBy?: "agent" | "user";
  revision?: Revision;
}
/**
 * Área nomeada do canvas (ex.: 'Backend'). Pode estar ligada a entidades semânticas para o Navigator resolver 'vá para o backend'.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Region".
 */
export interface Region {
  id: RegionId;
  title: string;
  bounds: Rect;
  semanticEntityIds?: SemanticEntityId[];
  color?: string;
  revision?: Revision;
}
/**
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "Canvas".
 */
export interface Canvas {
  objects: CanvasObject[];
  regions: Region[];
}
/**
 * Formato de exportação/importação do workspace inteiro. É também o que o agente recebe (filtrado) em workspace.get_snapshot. A integridade referencial é verificada por scripts/validar.py, não só pelo schema.
 *
 * This interface was referenced by `OpenSemanticContracts`'s JSON-Schema
 * via the `definition` "WorkspaceSnapshot".
 */
export interface WorkspaceSnapshot {
  schemaVersion: "0.2";
  workspace: Workspace;
  projects: Project[];
  artifacts: ArtifactReference[];
  semantic: {
    entities: SemanticEntity[];
    relations: SemanticRelation[];
    evidence: Evidence[];
  };
  mods: ModInstance[];
  diagrams: DiagramModel[];
  canvas: Canvas;
  navigation: NavigationState;
  /**
   * Camadas de assunto (docs/funcionalidades/11-camadas.md). Ausente em workspaces antigos: vale lista vazia.
   */
  layers?: Layer[];
}
