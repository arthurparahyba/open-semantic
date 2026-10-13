// Leituras do projeto pelas ferramentas: o projeto de um pedido, a limpeza do caminho e a resolução do artefato.
// Toda leitura passa pelo protocolo, assinada pelo agente, e fica no histórico de ações como qualquer operação.
import type { OperationResult, WorkspaceSnapshot } from "@open-semantic/protocol";
import { activeProject } from "@open-semantic/workspace-store";

import { CLAUDE_AGENT } from "../types.js";
import type { ToolContext } from "./tool.js";

/** Onde uma leitura acontece: o projeto, a raiz e o caminho já limpo (vazio é a raiz). */
export interface ProjectPath {
  projectId: string;
  rootId: string;
  rootRef: string;
  path: string;
}

/**
 * Caminho relativo à raiz do projeto como o modelo escreveu: tira espaços, "./" e "." sozinho do começo
 * e as barras das pontas. Um ponto que faz parte do nome fica (".github", ".env").
 */
export function cleanPath(path: string): string {
  return path
    .trim()
    .replace(/^(?:\.(?:\/+|$))+/, "")
    .replace(/^\/+|\/+$/g, "");
}

/** O projeto do pedido (o ativo quando o modelo não diz outro) e o caminho limpo. */
export function locate(snapshot: WorkspaceSnapshot, input: { projectId?: unknown; path?: unknown }): ProjectPath {
  const project = input.projectId ? snapshot.projects.find((p) => p.id === input.projectId) : activeProject(snapshot);
  if (!project) throw new Error(input.projectId ? `Projeto ${String(input.projectId)} não existe.` : "Nenhuma pasta de projeto aberta.");
  return { projectId: project.id, rootId: project.roots[0].id, rootRef: project.rootRef, path: cleanPath(String(input.path ?? "")) };
}

/** Leitura pelo protocolo, assinada pelo agente. Falhar é erro, com a mensagem da operação. */
export async function agentRead(ctx: ToolContext, operation: string, args: Record<string, unknown>): Promise<OperationResult> {
  const result = await ctx.dispatcher.dispatch({
    operationId: `act_${ctx.newId()}`,
    operation,
    arguments: args,
    authorization: { actor: CLAUDE_AGENT },
  });
  if (result.status !== "succeeded") throw new Error(result.error?.message ?? `${operation} falhou`);
  return result;
}

/** O artefato de um caminho do projeto; o caminho vazio é a raiz. */
export async function resolvePath(ctx: ToolContext, { projectId, rootId, rootRef, path }: ProjectPath): Promise<string> {
  if (!path) return rootRef;
  const result = await agentRead(ctx, "project.resolve", { projectId, rootId, path });
  return (result.output as { artifact: { id: string } }).artifact.id;
}
