import { describe, expect, it } from "vitest";

import { acceptsAll, asksForPlanning } from "../src/conversation/planning.js";

describe("pedido amplo", () => {
  it("reconhece pedidos de planejamento de uma funcionalidade", () => {
    expect(asksForPlanning("se eu quiser criar uma funcionalidade de cadastro de produtos para pets. como faço desde a criacao da tela, até o backend e banco de dados?")).toBe(true);
    expect(asksForPlanning("Como crio uma nova tela de cadastro de produtos?")).toBe(true);
    expect(asksForPlanning("quero implementar um crud de vacinas")).toBe(true);
  });

  it("não confunde com pedidos pontuais ou de explicação", () => {
    expect(asksForPlanning("explique a arquitetura")).toBe(false);
    expect(asksForPlanning("qual a versão do Java?")).toBe(false);
    expect(asksForPlanning("como funciona o cadastro de pet?")).toBe(false);
  });

  it("aceita 'todos' como resposta a uma pergunta rápida", () => {
    expect(acceptsAll("todos que forem necessarios")).toBe(true);
    expect(acceptsAll("Tanto faz")).toBe(true);
    expect(acceptsAll("todos os controllers do projeto estão errados?")).toBe(false);
  });
});
