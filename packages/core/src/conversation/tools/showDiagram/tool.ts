// show_diagram: a resposta visual. O modelo descreve só o desenho (caixas, ligações, caminhos que viu e a legenda);
// daqui sai um lote comum que registra as unidades de contexto, cria ou completa o diagrama ancorado e o enquadra.
import { agentRead, locate, type ProjectPath } from "../project.js";
import type { ConversationTool, ToolContext } from "../tool.js";
import { planShowDiagram } from "./plan.js";
import { DIAGRAM_KINDS, type ResolvedPath, type ShowDiagramInput } from "./types.js";

export const showDiagram: ConversationTool = {
  name: "show_diagram",
  description:
    "Your main way to answer. Draws (or completes) a diagram on the canvas, anchored to its subject, and frames it for the user. Send only the picture: boxes, links, the project paths where you saw each box and a short caption. The app records each box as a context unit (verified when it has a path that exists in the project, inferred otherwise; inferred boxes are drawn dashed), creates or patches the diagram and moves the camera to it, in one batch. Calling it again with the same diagramId completes that diagram: new boxes and links are added, existing ones updated, nothing is removed unless listed in remove. Returns the batch result and, for each node, its unit and knowledge status.",
  runsBatch: true,
  inputSchema: () => ({
    type: "object",
    required: ["diagramId", "title", "kind", "caption", "nodes"],
    properties: {
      diagramId: { type: "string", description: "dgm_ plus a readable name, e.g. dgm_petclinic_overview. Reuse the id of an existing diagram about the same subject to complete it." },
      title: { type: "string", description: "Short title shown on the diagram, in Portuguese." },
      kind: { enum: [...DIAGRAM_KINDS], description: "architecture: what the system is made of (overview, layers, modules). flow / sequence: how a request or use case moves through the parts. dependency: who depends on whom." },
      caption: { type: "string", maxLength: 600, description: "One to three short sentences in Portuguese that read the diagram for the user, naming its boxes. Shown with the diagram and in the chat." },
      projectId: { type: "string", description: "Only when it is not the active project." },
      about: { type: "string", description: "The context unit the diagram is about: an existing sem_ id, or the id of one of this call's nodes (for a detail diagram of a part). Omit for the whole repository." },
      direction: { enum: ["LR", "TB"], description: "Default: TB for architecture and dependency, LR for flow and sequence." },
      nodes: {
        type: "array",
        minItems: 1,
        maxItems: 30,
        items: {
          type: "object",
          required: ["id", "label"],
          properties: {
            id: { type: "string", description: "Short id, e.g. owner or nd_owner." },
            label: { type: "string", description: "Text in the box (short)." },
            kind: { type: "string", description: "service, module, component, api, endpoint, data_store, application, actor, external, queue, concept." },
            unit: { type: "string", description: "Existing context unit (sem_ id from <workspace>) this box represents." },
            path: { type: "string", description: "Folder or file of the project (relative to its root) where you saw this. Makes the box verified. Omit when you only suppose it." },
            seen: { type: "string", description: "What you saw there, in one short sentence (evidence)." },
          },
          additionalProperties: false,
        },
      },
      edges: {
        type: "array",
        maxItems: 60,
        items: {
          type: "object",
          required: ["from", "to"],
          properties: {
            from: { type: "string", description: "Node id." },
            to: { type: "string", description: "Node id." },
            label: { type: "string", description: "Short verb or protocol, e.g. 'usa', 'HTTP', 'grava'." },
            type: { type: "string", description: "depends_on, calls, communicates_with, reads, writes, contains, exposes, implements." },
            seen: { type: "boolean", description: "True when you saw this link in the code at the source node's path." },
          },
          additionalProperties: false,
        },
      },
      remove: { type: "array", items: { type: "string" }, description: "Node ids to take out of an existing diagram (their links go too)." },
    },
    additionalProperties: false,
  }),
  async run(input, ctx) {
    const diagram = input as unknown as ShowDiagramInput;
    const snapshot = ctx.snapshot();
    const where = locate(snapshot, diagram.projectId ? { projectId: diagram.projectId } : {});
    const plan = await planShowDiagram(diagram, snapshot, { id: where.projectId }, (path) => resolveIn(ctx, where, path));
    const result = await ctx.runBatch({ intent: plan.intent, steps: plan.steps });
    return { ...result, nodes: plan.nodes, ...(plan.notes.length ? { notes: plan.notes } : {}) };
  },
};

/** O artefato de um caminho do projeto, ou undefined quando ele não existe. */
async function resolveIn(ctx: ToolContext, { projectId, rootId }: ProjectPath, path: string): Promise<ResolvedPath | undefined> {
  try {
    const result = await agentRead(ctx, "project.resolve", { projectId, rootId, path });
    const artifact = result.output?.artifact as { id: string; kind: ResolvedPath["kind"] };
    return { artifactId: artifact.id, kind: artifact.kind };
  } catch {
    return undefined;
  }
}
