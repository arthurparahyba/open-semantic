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
  /\b(quero|queria|preciso|gostaria de|vou) (criar|implementar|adicionar|construir|desenvolver|planejar|especificar|desenhar|projetar) (uma|um) (nova |novo )?(funcionalidade|feature|recurso|tela|cadastro|crud|modulo|servico|processo)/,
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
    "Cada pedido é UMA etapa curta (poucas leituras, um diagrama). A ordem das etapas é: " +
    "1) Processo: entreviste o usuário com um diagrama bpmn. Leia só o essencial do projeto (no máximo 3 leituras) e, na camada de especificação que o app já abriu " +
    "(não crie camada), desenhe um rascunho do processo de negócio em bpmn, com uma raia (lane) por ator — quem usa, a equipe, o sistema — (início, tarefas, decisões, fim; 5 a 9 elementos), " +
    "sem detalhes técnicos. Na legenda, faça uma ou duas perguntas objetivas sobre o fluxo (o que falta, qual decisão vale). Enquanto o usuário ajustar o processo, atualize o mesmo bpmn. " +
    "2) Interface: wireframe da tela nova, seguindo as telas que o projeto já tem. 3) Back-end: sequence do caminho da requisição (tela, controller, serviço, repositório, banco), " +
    "com os nomes no padrão do projeto. 4) Dados: diagrama er com as tabelas novas e as que elas usam, com colunas e relações. " +
    "Cada etapa fica na mesma camada, embaixo da anterior. Na continuação, use o diagrama e a camada da etapa anterior que estão no <workspace>. " +
    "O que ainda não existe no código é suposição (sem path). " +
    "Uma especificação é de um de dois casos. Cenário novo: algo sem equivalente no sistema; os diagramas são novos, no padrão do projeto. " +
    "Mudança sobre o existente: parta do diagrama da base sobre o assunto (mesmos nomes) e, depois de desenhar, use mark_diagram para mostrar a diferença: " +
    "novo no que entra, muda no que é alterado, remove no que sai; o que fica igual não leva marca. " +
    "Quando o usuário disser que quer implementar, sugira nos próximos passos \"Preparar a implementação\". " +
    "Termine sempre com uma legenda de uma ou duas frases que pergunta se é isso, e na última linha: " +
    '"Próximos passos: <opção 1> | <opção 2> | <opção 3>" (ações curtas, como "Seguir para a interface" ou "Ajustar o processo").',
};

const BROAD = [
  /\b(como funciona|me explique|me explica|explique|explica) (todo |toda )?(o|a) (sistema|aplicacao|app|projeto|plataforma|produto|processo) (inteir[oa]|todo|toda|como um todo|de ponta a ponta)\b/,
  /\b(visao (geral|completa) (de tudo|do sistema|da aplicacao|do projeto)|explicacao (ampla|completa|geral)|tour (pelo|pela) (sistema|aplicacao|projeto|codigo))\b/,
  /\b(quero|preciso|gostaria de) entender (o|a) (sistema|aplicacao|projeto|codigo|plataforma)( inteir[oa]| todo| toda| como um todo)?\b/,
  /\bme (de|da) um panorama\b/,
];

/** Explicação ampla: visão geral primeiro e as partes principais embaixo, como um documento, de uma vez. */
export const BROAD_MODE: ExecutionMode = {
  id: "ampla",
  name: "Explicação ampla",
  activatesWhen: (message) => BROAD.some((re) => re.test(normalized(message))),
  cadence: "once",
  limits: (base) => ({ ...base, maxModelCalls: Math.round(base.maxModelCalls * 1.5), maxBatches: base.maxBatches + 3 }),
  instructions:
    "[app] Modo: explicação ampla. Responda como um documento curto que cresce para baixo, na camada atual (não abra camada nova): " +
    "primeiro a visão geral (architecture ou layers) com heading e intro; depois 2 a 4 seções, uma por parte principal, cada uma com o diagrama do tipo certo " +
    "(sequence para um fluxo importante, tree para a organização do código, er para os dados, bpmn para um processo de negócio), continuando a anterior. " +
    "Leia o suficiente para cada parte, sem ler o repositório inteiro. A legenda final resume em duas frases e cita as seções.",
};

const IMPLEMENTATION = [
  /\b(preparar|prepare|comecar|vamos para|partir para|ir para) a implementacao\b/,
  /\b(quero|vamos|pode|podemos|bora) (agora )?(realmente )?(implementar|executar a implementacao)\b(?! (uma|um|novas?|novos?)\b)/,
  /^(implementar|implemente)\b(?! (uma|um|novas?|novos?)\b)/,
  /\bcriterios de aceite\b/,
  /\b(ja )?implementei\b|\b(ja )?(foi|esta|ficou) implementad[oa]\b|\bterminei (a implementacao|de implementar)\b/,
  /\b(validar|valide|verificar|verifique|revalidar) (os |todos os )?criterios\b/,
  /\b(levar|leve|incorporar|incorpore) (isso |a mudanca |tudo )?(para|na|a) (a )?base\b/,
];

/** O pedido é para implementar o que foi especificado (ou validar e fechar a implementação)? */
export function asksForImplementation(message: string): boolean {
  const text = normalized(message);
  return IMPLEMENTATION.some((re) => re.test(text));
}

/** Implementação: alvo e validação, a partir da especificação (docs/funcionalidades/16-fluxo-end-to-end.md). */
export const IMPLEMENTATION_MODE: ExecutionMode = {
  id: "implementacao",
  name: "Implementação",
  activatesWhen: (message, state) => asksForImplementation(message) || (state.previous === "implementacao" && continues(message) && !asksForPlanning(message)),
  cadence: "steps",
  nextSteps: ["Refinar os critérios", "Validar os critérios", "Levar para a base"],
  limits: (base) => ({ ...base, maxModelCalls: Math.round(base.maxModelCalls * 2), maxBatches: base.maxBatches + 6 }),
  instructions:
    "[app] Modo: implementação. Aqui se define o que implementar e como saber que ficou pronto; quem implementa é o agente de código que o usuário escolher, fora do app. " +
    "Nunca altere arquivos do projeto neste modo (nada de project.write_file). Não é um plano passo a passo: é o alvo e como validá-lo. Cada pedido é UMA etapa: " +
    "1) Preparar: a partir dos diagramas da camada de especificação (bpmn, wireframe, sequence, er no <workspace>), use a camada filha \"Implementação: <assunto>\" que o app já abriu " +
    "(não crie camada nem mova diagramas para ela; o app grava essa camada em specs/<assunto>.md no repositório). Para cada funcionalidade, use show_blocks: " +
    "um heading com o nome; um text com a intenção em uma ou duas frases; uma list com os passos focados no resultado (o que o usuário vê, não como codificar); " +
    "uma list \"Restrições do projeto\" com o padrão lido na base (camadas da arquitetura, telas parecidas, banco); " +
    "e uma table \"Critérios de aceite\" com as colunas Critério, Origem, Status. Derive os critérios dos diagramas: cada caminho do bpmn (o feliz e cada exceção) vira um cenário dado/quando/então; " +
    "cada wireframe vira uma verificação de tela (abrir, ver os campos, executar a ação); cada tabela do er vira uma checagem de banco; cada sequence, uma verificação de endpoint. " +
    "Na coluna Origem ponha o id do diagrama e do nó (dgm_x / nd_y); o Status começa pendente. Depois marque com mark_diagram os nós de origem como pendente. " +
    "Na legenda, diga que a especificação está em specs/<assunto>.md e que o botão Copiar pedido, no painel de camadas, copia o pedido para o agente de código. " +
    "2) Refinar: ajuste definição, restrições e critérios como o usuário pedir, sempre na mesma camada (o arquivo acompanha). " +
    "3) Validar (quando o usuário disser que implementou): leia o código com read_file e confira cada critério; reescreva a tabela com o Status (passou ou falhou, com o motivo curto) " +
    "e marque os nós de origem com mark_diagram: passou só quando todos os critérios daquele nó passaram, falhou se algum falhou. " +
    "4) Levar para a base: com tudo aprovado, tire as marcas de diferença (novo, muda) dos diagramas da especificação e mova-os para a base com layer.remove_members; " +
    "as camadas de especificação e implementação ficam como histórico. " +
    "Se a especificação mudou depois dos critérios, diga quais ficaram desatualizados e ofereça regerar. " +
    "Termine com uma legenda curta e, na última linha, \"Próximos passos: <opção 1> | <opção 2> | <opção 3>\".",
};

export const BUILTIN_MODES: ExecutionMode[] = [BRIEF_MODE, BROAD_MODE, PLANNING_MODE, IMPLEMENTATION_MODE];
