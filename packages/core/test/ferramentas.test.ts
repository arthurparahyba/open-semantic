// O registro das ferramentas do modelo e o caminho relativo ao projeto.
import { describe, expect, it } from "vitest";

import { cleanPath } from "../src/index.js";
import {
  TOOLS,
  ToolRegistry,
  type ConversationTool,
  type ToolContext,
} from "../src/conversation/tools/index.js";

const ctx = {} as ToolContext;

describe("registro de ferramentas", () => {
  it("manda as ferramentas ao modelo na ordem da lista e sabe quais rodam lotes", () => {
    const registry = new ToolRegistry(TOOLS, ["diagram.create"]);
    expect(registry.specs.map((s) => s.name)).toEqual([
      "show_diagram",
      "show_blocks",
      "get_workspace",
      "search_workspace",
      "list_dir",
      "read_file",
      "describe_operation",
      "run_batch",
    ]);
    expect([...registry.batchTools].sort()).toEqual([
      "run_batch",
      "show_blocks",
      "show_diagram",
    ]);
  });

  it("aceita uma ferramenta nova sem mexer no laço", async () => {
    const echo: ConversationTool = {
      name: "echo",
      description: "eco",
      inputSchema: () => ({ type: "object" }),
      run: (input) => input,
    };
    const result = await new ToolRegistry([echo], []).run(
      { id: "c1", name: "echo", input: { a: 1 } },
      ctx,
    );
    expect(result).toEqual({ callId: "c1", content: '{"a":1}' });
  });

  it("devolve erro ao modelo quando a ferramenta falha ou não existe", async () => {
    const boom: ConversationTool = {
      name: "boom",
      description: "",
      inputSchema: () => ({}),
      run: () => {
        throw new Error("falhou");
      },
    };
    const registry = new ToolRegistry([boom], []);
    expect(
      await registry.run({ id: "c1", name: "boom", input: {} }, ctx),
    ).toEqual({ callId: "c1", content: "falhou", isError: true });
    expect(
      await registry.run({ id: "c2", name: "nada", input: {} }, ctx),
    ).toMatchObject({ callId: "c2", isError: true });
  });
});

describe("cleanPath", () => {
  it("trata '/', './' e '.' como a raiz do projeto", () => {
    expect(cleanPath("/src/")).toBe("src");
    expect(cleanPath("././README.md")).toBe("README.md");
    expect(cleanPath(".")).toBe("");
    expect(cleanPath(" docs ")).toBe("docs");
    expect(cleanPath("../fora")).toBe("../fora");
  });
});
