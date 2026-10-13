// Regras sobre os projetos do workspace que valem igual no núcleo, no agente e na interface. Sem dependências de Node.
import type { Project, WorkspaceSnapshot } from "@open-semantic/protocol";

/** Projeto em que o agente trabalha quando o pedido não diz outro: o marcado como ativo ou, sem marca, o último aberto. */
export function activeProject(doc: Pick<WorkspaceSnapshot, "workspace" | "projects">): Project | undefined {
  const id = doc.workspace.activeProjectId;
  return (id ? doc.projects.find((p) => p.id === id) : undefined) ?? doc.projects[doc.projects.length - 1];
}
