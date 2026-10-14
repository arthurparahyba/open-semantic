// show_diagram: a resposta visual. O modelo descreve só o desenho (caixas, ligações, caminhos que viu e a legenda);
// daqui sai um lote comum que registra as unidades de contexto, cria ou completa o diagrama ancorado e o enquadra.
import { normalized } from "../../text.js";
import { agentRead, locate, type ProjectPath } from "../project.js";
import type { ConversationTool, ToolContext } from "../tool.js";
import { planShowDiagram } from "./plan.js";
import { parseSource, SourceError, type NodeEvidence } from "./source.js";
import { DIAGRAM_KINDS, type ResolvedPath, type ShowDiagramInput } from "./types.js";

export const showDiagram: ConversationTool = {
  name: "show_diagram",
  description:
    "Your main way to answer. Draws (or completes) a diagram on the canvas, anchored to its subject, and frames it for the user. Pick the kind that shows the shape of the answer (see kind), write the picture in source (short text, Mermaid-like) and put what you saw in the project for each box in evidence. The app records each box as a context unit (verified only when you read that file with read_file, or listed that folder with list_dir, in this conversation and the box's name appears there; inferred otherwise, drawn dashed. Something new proposed in a specification is never verified), creates or patches the diagram and moves the camera to it, in one batch. Build explanations top to bottom like a document: give each diagram a heading and a short intro, add notes (text, list, table) when they help, and say with continues/details how it relates to what is already on the canvas; the app places it (below for the next step, to the right for a detail). Calling it again with the same diagramId completes that diagram: new boxes and links are added, existing ones updated, nothing is removed unless listed in remove (in a sequence, the messages you send replace the old ones). Returns the batch result and, for each node, its unit and knowledge status.",
  runsBatch: true,
  inputSchema: () => ({
    type: "object",
    required: ["diagramId", "title", "kind", "why", "caption", "source"],
    properties: {
      diagramId: { type: "string", description: "dgm_ plus a readable name, e.g. dgm_petclinic_overview. Reuse the id of an existing diagram about the same subject to complete it." },
      title: { type: "string", description: "Short title shown on the diagram, in Portuguese." },
      kind: { enum: [...DIAGRAM_KINDS], description: KIND_GUIDE },
      why: { type: "string", maxLength: 200, description: "One short sentence in Portuguese: why this kind shows the answer best (e.g. 'o pedido é sobre níveis da aplicação')." },
      caption: { type: "string", maxLength: 600, description: "One to three short sentences in Portuguese that read the diagram for the user, naming its boxes. Shown with the diagram and in the chat." },
      source: { type: "string", maxLength: 6000, description: SOURCE_GUIDE },
      evidence: {
        type: "object",
        description: 'What you saw for each box, by node id: {"owner": {"path": "src/owner", "seen": "Pacote com controller e repositório.", "kind": "module"}}. path makes the box verified when you read it in this conversation and the name is there; unit reuses an existing sem_ id. For a link, key "a->b" with {"seen": true} when the code at a\'s path shows it. Boxes without evidence are suppositions.',
        additionalProperties: {
          type: "object",
          properties: {
            path: { type: "string", description: "Folder or file of the project (relative to its root) where you saw this." },
            seen: { description: "Node: what you saw there, one short sentence. Link: true when seen in the code." },
            kind: { type: "string", description: "service, module, component, api, endpoint, data_store, application, actor, external, queue, concept; in a wireframe, the element type (button, input, panel...)." },
            unit: { type: "string", description: "Existing context unit (sem_ id from <workspace>) this box represents." },
            type: { type: "string", description: "Link only: depends_on, calls, communicates_with, reads, writes, contains, exposes, implements." },
          },
          additionalProperties: false,
        },
      },
      projectId: { type: "string", description: "Only when it is not the active project." },
      about: { type: "string", description: "The context unit the diagram is about: an existing sem_ id, or the id of one of this call's nodes (for a detail diagram of a part). Omit for the whole repository." },
      direction: { enum: ["LR", "TB"], description: "Only for architecture, flow and dependency. Default: TB for architecture and dependency, LR for flow." },
      remove: { type: "array", items: { type: "string" }, description: "Node ids to take out of an existing diagram (their links go too)." },
      heading: { type: "string", maxLength: 120, description: "Section title shown above the diagram, in Portuguese (e.g. 'Infraestrutura e cache'). Give one for every new step of an explanation." },
      intro: { type: "string", maxLength: 600, description: "One to three sentences in Portuguese shown above the diagram, under the heading: what this part of the explanation is about." },
      notes: {
        type: "array",
        maxItems: 4,
        description: "Blocks shown under the diagram that add to it: text (a paragraph), list (items, ordered for steps) or table (columns and rows, e.g. a comparison).",
        items: {
          type: "object",
          required: ["kind"],
          properties: {
            kind: { enum: ["text", "list", "table"] },
            title: { type: "string", maxLength: 120 },
            text: { type: "string", maxLength: 1200 },
            items: { type: "array", maxItems: 20, items: { type: "string", maxLength: 300 } },
            ordered: { type: "boolean" },
            columns: { type: "array", maxItems: 6, items: { type: "string", maxLength: 80 } },
            rows: { type: "array", maxItems: 20, items: { type: "array", maxItems: 6, items: { type: "string", maxLength: 200 } } },
          },
          additionalProperties: false,
        },
      },
      continues: { type: "string", description: "Id (dgm_ or blk_) of what this diagram follows in the explanation; it goes below it. Default for a new diagram: below the last diagram of the project." },
      details: { type: "string", description: "Id (dgm_ or blk_) of what this diagram zooms into (e.g. a sequence detailing one box of an overview); it goes to its right." },
    },
    additionalProperties: false,
  }),
  async run(input, ctx) {
    const diagram = fromSource(input);
    const snapshot = ctx.snapshot();
    const where = locate(snapshot, diagram.projectId ? { projectId: diagram.projectId } : {});
    const plan = await planShowDiagram(diagram, snapshot, { id: where.projectId }, {
      resolve: (path) => resolveIn(ctx, where, path),
      unsupported: (path, label, kind) => unsupported(ctx.reads, path, label, kind),
    });
    const result = await ctx.runBatch({ intent: plan.intent, steps: plan.steps });
    return { ...result, nodes: plan.nodes, ...(plan.notes.length ? { notes: plan.notes } : {}) };
  },
};

/**
 * Verificado é o que o agente leu nesta conversa, não o que ele diz ter visto: um arquivo lido em que o nome da
 * caixa aparece, ou uma pasta listada (ou com arquivo lido dentro). Um campo novo de uma especificação aponta
 * para um arquivo que não o contém, e fica como suposição.
 */
export function unsupported(reads: Map<string, string | null>, path: string, label: string, kind: string): string | undefined {
  if (kind === "process") return undefined;
  const inside = (p: string) => !path || p === path || p.startsWith(`${path}/`);
  if (kind === "directory") return [...reads.keys()].some(inside) ? undefined : `a pasta ${path || "raiz"} não foi listada nesta conversa`;
  const content = reads.get(path);
  if (typeof content !== "string") return `${path} não foi lido nesta conversa`;
  const text = `${normalized(content).replace(/ /g, "")} ${normalized(path).replace(/ /g, "")}`;
  const words = normalized(label).split(" ").filter((w) => w.length >= 4);
  const joined = normalized(label).replace(/ /g, "");
  if (text.includes(joined) || words.some((w) => text.includes(w))) return undefined;
  return `o nome não aparece em ${path}`;
}

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

/** O guia de escolha do tipo: pela forma da resposta, não pelo assunto (docs/funcionalidades/12-tipos-de-diagrama.md). */
export const KIND_GUIDE =
  "Choose by the shape of the answer, not by the subject. layers: how the system is organized in levels or tiers (camadas, níveis, front/back/dados, apresentação/domínio/infra); drawn as stacked bands, few arrows. sequence: how a feature, request or use case happens step by step between parts (como funciona X, como está implementado, o que acontece quando); drawn as participants with lifelines and ordered messages. tree: how things contain each other (pastas, módulos dentro de módulos, como o monorepo/repositório está dividido); drawn as a hierarchy. architecture: an overview of what the system is made of and who talks to whom. flow: a process with steps and branches. dependency: who depends on whom. wireframe: what a screen looks like (como é a tela, a interface, a página, o que o usuário vê ao abrir); drawn as boxes inside boxes like a mockup, built from the screen's templates and components. bpmn: a business process as the user sees it (who does what, in what order, with decisions); drawn with start/end circles, tasks and decision diamonds; use it to agree on a feature's flow before any technical detail. er: the data model (tabelas, colunas, chaves, relações); drawn as tables with their columns. When the user asks about layers, never use architecture; when they ask how a feature works, prefer sequence; when they ask what a screen looks like, always use wireframe.";

const SOURCE_GUIDE = [
  "The picture as short text, one item per line. A box is id[Label] (optionally id[Label]:kind); a link is a --> b : label. Use simple ids (letters, digits, _).",
  "layers: 'layer Name' starts a band (top to bottom); the boxes after it belong to it; links only where a call crosses bands. Example:\nlayer Interface\n  ui[Renderer React]\nlayer Núcleo\n  core[Core]\nui --> core : IPC",
  "sequence: 'participant id[Label]' in column order, then one message per line in time order: a ->> b : call, b -->> a : reply. Example:\nparticipant user[Usuário]\nparticipant ui[Editor]\nparticipant fs[Disco]\nuser ->> ui : salva\nui ->> fs : grava arquivo\nfs -->> ui : ok",
  "tree: one box per line; indentation says what contains what. Example:\nrepo[open-semantic]\n  apps[apps]\n    desktop[desktop]\n  packages[packages]",
  "wireframe: one screen element per line as id[Label]:type; indentation puts an element inside the one above it; no arrows. Containers: screen, header, sidebar, main, panel, card, form, modal, footer stack their children top to bottom; row, toolbar, nav, tabs put them side by side. Elements: button, link, tab, input, search, select, checkbox, text, title, image, icon, list, table, chart, editor. Read the templates/components of the screen first and give each element the file where you saw it as evidence (unseen ones stay dashed). Example:\nscr[Tela inicial]:screen\n  top[Topo]:header\n    logo[Logo]:image\n    busca[Buscar]:search\n    entrar[Entrar]:button\n  corpo[Corpo]:row\n    menu[Menu]:sidebar\n      l1[Pedidos]:link\n    lista[Pedidos recentes]:main\n      tab[Tabela de pedidos]:table",
  "bpmn: 'lane Actor' starts a swimlane (one per person, team or system that does the work); the elements after it belong to it. Elements have a type: start, end, task, gateway. Write the links in process order, with the condition on each link leaving a gateway; a link back to an earlier step is drawn as a loop underneath. Keep task labels short (verb + object). Example:\nlane Lojista\ni[Início]:start\nf[Preenche produto]:task\nlane Sistema\nv[Dados válidos?]:gateway\ns[Salva produto]:task\nfim[Produto cadastrado]:end\ni --> f\nf --> v\nv --> s : sim\nv --> f : não\ns --> fim",
  "er: one table per line as id[table_name]; the indented lines under it are its columns (name, type, PK/FK); links are relationships with cardinality. Example:\nowners[owners]\n  id integer PK\n  first_name varchar\npets[pets]\n  id integer PK\n  owner_id integer FK\nowners --> pets : 1..N",
  "architecture, flow, dependency: boxes and links (a --> b : label).",
].join("\n\n");

/** A entrada do modelo (texto + evidências) vira os nós e ligações do plano. Sem source, vale a forma antiga (nodes/edges). */
function fromSource(input: Record<string, unknown>): ShowDiagramInput {
  const { source, evidence, why: _why, ...rest } = input as { source?: unknown; evidence?: Record<string, NodeEvidence>; why?: unknown } & Record<string, unknown>;
  const base = rest as unknown as ShowDiagramInput;
  if (typeof source !== "string") return base;
  try {
    return { ...base, ...parseSource(base.kind, source, evidence ?? {}) };
  } catch (err) {
    if (err instanceof SourceError) throw new Error(`source: ${err.message}`);
    throw err;
  }
}
