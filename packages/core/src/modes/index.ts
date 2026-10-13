// Modos de execução: como o agente conduz um pedido. O modo é escolhido localmente (sem chamada ao modelo),
// e só as instruções do modo ativo vão junto do pedido. Além do prompt, o modo define a interação:
// tipos de diagrama, cadência (de uma vez ou em etapas) e os botões de próximo passo.
import type { TurnLimits } from "../conversation/budget.js";
import { normalized } from "../conversation/text.js";

export interface ModeState {
  /** Modo do pedido anterior, para um modo em etapas continuar. */
  previous?: string;
}

export interface ExecutionMode {
  id: string;
  /** Nome curto, mostrado no chat. */
  name: string;
  /** Quando o modo é ativado. Regra local e barata: roda em cada mensagem. */
  activatesWhen(message: string, state: ModeState): boolean;
  /** Instruções que vão junto do pedido quando o modo está ativo (nenhuma: o comportamento padrão do agente). */
  instructions?: string;
  /** "steps": cada pedido é uma etapa curta, que termina com botões de próximo passo. */
  cadence: "once" | "steps";
  /** Botões de próximo passo quando o agente não sugerir os seus. */
  nextSteps?: string[];
  /** Tetos do pedido neste modo. */
  limits?(base: TurnLimits): TurnLimits;
}

export class ModeRegistry {
  private readonly modes: ExecutionMode[] = [];

  /** O último registrado tem prioridade; o primeiro é o padrão. */
  constructor(modes: ExecutionMode[] = []) {
    for (const m of modes) this.register(m);
  }

  register(mode: ExecutionMode) {
    const i = this.modes.findIndex((m) => m.id === mode.id);
    if (i >= 0) this.modes[i] = mode;
    else this.modes.push(mode);
  }

  list(): readonly ExecutionMode[] {
    return this.modes;
  }

  get(id: string): ExecutionMode | undefined {
    return this.modes.find((m) => m.id === id);
  }

  /** O modo da mensagem: o primeiro (de trás para frente) que se ativa, ou o padrão. */
  pick(message: string, state: ModeState = {}): ExecutionMode {
    for (let i = this.modes.length - 1; i > 0; i--) if (this.modes[i]!.activatesWhen(message, state)) return this.modes[i]!;
    return this.modes[0]!;
  }
}

/** Botões de próximo passo no fim da resposta: uma linha "Próximos passos: A | B | C". */
const NEXT_LINE = /^\s*pr[oó]ximos passos\s*:\s*(.+)$/im;

export function splitNextSteps(text: string): { text: string; next: string[] } {
  const m = NEXT_LINE.exec(text);
  if (!m) return { text, next: [] };
  const next = m[1]!
    .split("|")
    .map((s) => s.trim().replace(/^["“]|["”]$/g, ""))
    .filter(Boolean)
    .slice(0, 4);
  return { text: text.replace(m[0], "").trim(), next };
}

// --- Modos que vêm no app -------------------------------------------------------------------------

/** Explicação breve: o comportamento de sempre (um diagrama e uma legenda). É o padrão. */
export const BRIEF_MODE: ExecutionMode = {
  id: "breve",
  name: "Explicação breve",
  activatesWhen: () => true,
  cadence: "once",
};

const PLANNING = [
  /\bcomo (eu )?(faco|faria|crio|criaria|criar|implemento|implementaria|implementar|adiciono|adicionar|construo|construir|desenvolvo|desenvolver|monto|montar|fazer) (uma|um|a|o|esse|essa|novas?|novos?)? ?(nova |novo )?(funcionalidade|feature|recurso|tela|cadastro|crud|modulo|servico|endpoint|api|fluxo|processo)/,
  /\b(quero|queria|preciso|gostaria de|vou) (criar|implementar|adicionar|construir|desenvolver|planejar) (uma|um) (nova |novo )?(funcionalidade|feature|recurso|tela|cadastro|crud|modulo|servico|processo)/,
  /\bdesde (a|o) .{1,40}\bate (o|a|os|as) /,
  /\bda tela (ate|ao|aos) /,
  /\bdo (front ?end|frontend) (ate|ao) /,
  /\b(planeje|planejar|planejamento|me ajude a planejar|passo a passo para (criar|implementar|construir))\b/,
];

/** O pedido é amplo, de planejamento (várias partes), e pede um plano em etapas? */
export function asksForPlanning(message: string): boolean {
  const text = normalized(message);
  return PLANNING.some((re) => re.test(text));
}

/** Mensagem curta que continua a etapa atual ("seguir", "detalhar a tela", "volta"). */
const continues = (message: string) => normalized(message).split(" ").length <= 12;

/** Planejamento em etapas: rascunho visual do fluxo primeiro, depois uma peça por vez, validando com o usuário. */
export const PLANNING_MODE: ExecutionMode = {
  id: "planejamento",
  name: "Planejamento em etapas",
  activatesWhen: (message, state) => asksForPlanning(message) || (state.previous === "planejamento" && continues(message)),
  cadence: "steps",
  nextSteps: ["Seguir para a próxima etapa", "Ajustar esta etapa", "Encerrar o planejamento"],
  instructions:
    "[app] Modo: planejamento em etapas. Não pergunte de qual parte o usuário fala e não faça o plano inteiro de uma vez. " +
    "Cada pedido é UMA etapa curta (poucas leituras, um diagrama). " +
    "Primeira etapa: leia só o essencial do projeto (no máximo 3 leituras), abra uma camada para a discussão com layer.create " +
    "(ancorada no elemento da visão geral de onde ela nasce) e desenhe um rascunho do fluxo de ponta a ponta em alto nível (kind flow: " +
    "início, passos, decisões, fim; 5 a 9 caixas). Etapas seguintes, conforme o usuário pedir: refine uma peça por vez na mesma camada " +
    "(tela: wireframe; back-end: architecture; caminho da requisição: sequence; dados: modelo de dados), recomendando o que o projeto já " +
    "usa como padrão e marcando o resto como suposição. Na continuação, use o diagrama e a camada da etapa anterior que estão no <workspace>. " +
    "Termine sempre com uma legenda de uma ou duas frases que pergunta se é isso, e na última linha: " +
    '"Próximos passos: <opção 1> | <opção 2> | <opção 3>" (ações curtas, como "Detalhar a tela" ou "Ajustar o fluxo").',
};

export const BUILTIN_MODES: ExecutionMode[] = [BRIEF_MODE, PLANNING_MODE];
