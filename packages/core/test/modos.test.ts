import { describe, expect, it } from "vitest";

import { BUILTIN_MODES, ModeRegistry, asksForImplementation, asksForPlanning, splitNextSteps } from "../src/modes/index.js";
import { acceptsAll } from "../src/conversation/acceptAll.js";

const modes = new ModeRegistry(BUILTIN_MODES);

describe("modos de execução", () => {
  it("pedido pontual fica no modo breve", () => {
    expect(modes.pick("explique a arquitetura").id).toBe("breve");
    expect(modes.pick("qual a versão do Java?").id).toBe("breve");
  });

  it("pedido de construir algo entra no planejamento em etapas", () => {
    expect(modes.pick("se eu quiser criar uma funcionalidade de cadastro de produtos para pets. como faço desde a criacao da tela, até o backend e banco de dados?").id).toBe("planejamento");
    expect(asksForPlanning("quero implementar um crud de vacinas")).toBe(true);
    expect(asksForPlanning("como funciona o cadastro de pet?")).toBe(false);
  });

  it("uma resposta curta continua a etapa; uma pergunta longa nova volta ao breve", () => {
    expect(modes.pick("Detalhar a tela", { previous: "planejamento" }).id).toBe("planejamento");
    expect(modes.pick("Detalhar a tela").id).toBe("breve");
    expect(
      modes.pick("me explica como o repositório de donos conversa com o banco de dados e quais consultas ele faz quando abre a página", { previous: "planejamento" }).id,
    ).toBe("breve");
  });

  it("pedido de entender o sistema inteiro entra na explicação ampla", () => {
    expect(modes.pick("me explique o sistema inteiro").id).toBe("ampla");
    expect(modes.pick("quero entender a aplicação como um todo").id).toBe("ampla");
    expect(modes.pick("como funciona o cadastro de pet?").id).toBe("breve");
  });

  it("pedido de implementar o que foi especificado entra na implementação (doc 16)", () => {
    expect(modes.pick("agora quero realmente implementar isso").id).toBe("implementacao");
    expect(modes.pick("Preparar a implementação").id).toBe("implementacao");
    expect(modes.pick("Implementar").id).toBe("implementacao");
    expect(modes.pick("Validar os critérios").id).toBe("implementacao");
    expect(modes.pick("Levar para a base").id).toBe("implementacao");
    expect(modes.pick("Seguir", { previous: "implementacao" }).id).toBe("implementacao");
    expect(asksForImplementation("quero implementar um crud de vacinas")).toBe(false);
    expect(modes.pick("quero implementar um crud de vacinas").id).toBe("planejamento");
  });

  it("um modo registrado depois tem prioridade e o padrão continua sendo o primeiro", () => {
    const local = new ModeRegistry(BUILTIN_MODES);
    local.register({ id: "bpmn", name: "Processo", activatesWhen: (m) => /processo/.test(m), cadence: "steps" });
    expect(local.pick("desenhe o processo de compra").id).toBe("bpmn");
    expect(local.pick("oi").id).toBe("breve");
  });

  it("separa os botões de próximo passo da legenda", () => {
    const { text, next } = splitNextSteps("Rascunho do fluxo de cadastro. É isso?\nPróximos passos: Detalhar a tela | Ajustar o fluxo | Ver o back-end");
    expect(text).toBe("Rascunho do fluxo de cadastro. É isso?");
    expect(next).toEqual(["Detalhar a tela", "Ajustar o fluxo", "Ver o back-end"]);
    expect(splitNextSteps("Sem botões.").next).toEqual([]);
  });

  it("aceita 'todos' como resposta a uma pergunta rápida", () => {
    expect(acceptsAll("todos que forem necessarios")).toBe(true);
    expect(acceptsAll("todos os controllers do projeto estão errados?")).toBe(false);
  });
});
