// Agente roteirizado (M2): planos fixos que exercitam o protocolo inteiro sem IA.
// O primeiro é o fluxo de referência de contracts/exemplos/lote-referencia.json, adaptado ao projeto aberto.
import { randomUUID } from "node:crypto";

import type { BatchPlan, WorkspaceSnapshot } from "@open-semantic/protocol";

export const AGENT = { kind: "agent" as const, id: "roteirizado" };

export interface ScriptInfo {
  id: string;
  title: string;
  description: string;
}

export const SCRIPTS: ScriptInfo[] = [
  {
    id: "arquitetura",
    title: "Criar o backend e mostrar a arquitetura",
    description: "Cria a pasta backend/, registra o que sabe e o que supõe, abre um Explorer e desenha a arquitetura.",
  },
  {
    id: "mostrar_backend",
    title: "Mostrar o backend",
    description: "Leva a câmera até a região Backend (se você não estiver mexendo no canvas).",
  },
  {
    id: "remover_explorer",
    title: "Remover o Explorer do backend",
    description: "Pede para remover um mod: precisa da sua confirmação.",
  },
];

export class ScriptError extends Error {}

/** Monta o plano do roteiro sobre o primeiro projeto aberto. Ids de operação são novos a cada execução. */
export function scriptedPlan(scriptId: string, snapshot: WorkspaceSnapshot, newId = () => randomUUID().replaceAll("-", "").slice(0, 12)): BatchPlan {
  const project = snapshot.projects[0];
  if (!project) throw new ScriptError("Abra uma pasta antes de pedir algo ao agente.");
  const run = newId();
  const op = (n: number) => `act_${run}_${String(n).padStart(3, "0")}`;
  const authorization = { actor: AGENT };
  const projectId = project.id;
  const rootId = project.roots[0]!.id;

  switch (scriptId) {
    case "arquitetura":
      return {
        batchId: `bat_${run}`,
        turnId: `turn_${run}`,
        intent: "Crie o backend, abra o Explorer e mostre a arquitetura",
        policy: { onStepFailure: "skip_dependents", validateFirst: true, confirmation: "upfront" },
        steps: [
          { stepId: "mk_backend", request: { operationId: op(1), operation: "project.create_dir", arguments: { projectId, rootId, path: "backend" }, authorization } },
          {
            stepId: "sem_backend",
            dependsOn: ["mk_backend"],
            request: {
              operationId: op(2),
              operation: "semantic.upsert_observation",
              arguments: {
                entity: { id: "sem_backend", kind: "module", name: "Backend", projectId, artifactIds: [{ $bind: { step: "mk_backend", pointer: "/output/artifacts/0/id" } }] },
                evidence: {
                  id: `evd_backend_${run}`,
                  kind: "directory_listing",
                  artifactId: { $bind: { step: "mk_backend", pointer: "/output/artifacts/0/id" } },
                  summary: `Diretório backend/ confirmado pelo Project Runtime (operação ${op(1)}).`,
                },
              },
              authorization,
            },
          },
          {
            stepId: "infer_arch",
            dependsOn: ["sem_backend"],
            request: {
              operationId: op(3),
              operation: "semantic.upsert_inference",
              arguments: {
                entities: [{ id: "sem_frontend", kind: "module", name: "Frontend", projectId }],
                relations: [{ id: "rel_front_back", type: "communicates_with", sourceId: "sem_frontend", targetId: "sem_backend", attributes: { protocol: "HTTP" } }],
                confidence: 0.7,
                rationale: "Uma aplicação com backend costuma ter um frontend que fala com ele por HTTP; ainda não há código que confirme.",
              },
              authorization,
            },
          },
          {
            stepId: "region",
            dependsOn: ["sem_backend"],
            request: {
              operationId: op(4),
              operation: "region.create",
              arguments: { regionId: "rgn_backend", title: "Backend", semanticEntityIds: ["sem_backend"], placement: { strategy: "free_space_near", anchorIds: [] } },
              authorization,
            },
          },
          {
            stepId: "explorer",
            dependsOn: ["mk_backend", "region"],
            request: {
              operationId: op(5),
              operation: "mod.create",
              arguments: {
                modId: "mod_backend_explorer",
                type: "explorer",
                title: "Backend",
                config: { rootRef: { $bind: { step: "mk_backend", pointer: "/output/artifacts/0/id" } } },
                semanticEntityIds: ["sem_backend"],
                placement: { regionId: "rgn_backend" },
              },
              authorization,
            },
          },
          {
            stepId: "diagram",
            dependsOn: ["infer_arch", "region"],
            request: {
              operationId: op(6),
              operation: "diagram.create",
              arguments: {
                diagramId: "dgm_arch",
                title: "Arquitetura",
                kind: "architecture",
                projectId,
                nodes: [
                  { id: "nd_frontend", label: "Frontend", kind: "module", semanticEntityId: "sem_frontend" },
                  { id: "nd_backend", label: "Backend", kind: "module", semanticEntityId: "sem_backend" },
                ],
                edges: [{ id: "edg_front_back", sourceNodeId: "nd_frontend", targetNodeId: "nd_backend", label: "HTTP", semanticRelationId: "rel_front_back" }],
                layout: { algorithm: "layered", direction: "LR" },
                placement: { strategy: "free_space_near", anchorIds: ["rgn_backend"] },
              },
              authorization,
            },
          },
          {
            stepId: "frame",
            dependsOn: ["explorer", "diagram"],
            request: {
              operationId: op(7),
              operation: "navigation.frame",
              arguments: { targets: { visualIds: ["dgm_arch", "mod_backend_explorer"] }, intent: "compare", highlight: true, reason: "Ver a arquitetura ao lado do Explorer do backend" },
              authorization,
            },
          },
        ],
      };

    case "mostrar_backend":
      return {
        batchId: `bat_${run}`,
        intent: "Mostre o backend",
        policy: {},
        steps: [
          {
            stepId: "frame",
            request: { operationId: op(1), operation: "navigation.frame", arguments: { targets: { regionId: "rgn_backend" }, intent: "focus", reason: "Ver o backend" }, authorization },
          },
        ],
      };

    case "remover_explorer":
      return {
        batchId: `bat_${run}`,
        intent: "Remova o Explorer do backend",
        policy: {},
        steps: [{ stepId: "remove", request: { operationId: op(1), operation: "mod.delete", arguments: { modId: "mod_backend_explorer" }, authorization } }],
      };

    default:
      throw new ScriptError(`Roteiro desconhecido: ${scriptId}`);
  }
}
