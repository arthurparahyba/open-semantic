// Onde a camada de implementação vira arquivo e o pedido para o agente de código (doc 16).
// Sem dependências de Node: a interface usa as mesmas regras.
import type { Layer } from "@open-semantic/protocol";

export const SPECS_DIR = "specs";
/** O modo Implementação nomeia a camada assim: "Implementação: Cadastro de produto". */
export const SPEC_LAYER = /^implementa[cç][aã]o\b\s*:?\s*/i;

export const isSpecLayer = (layer: Layer) => SPEC_LAYER.test(layer.name);

/** Nome do arquivo: o assunto da camada, sem acentos. */
export function specSlug(layer: Layer): string {
  const subject = layer.name.replace(SPEC_LAYER, "") || layer.name;
  const slug = subject
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || layer.id.replace(/^lyr_/, "");
}

/** O arquivo da camada, relativo à raiz do repositório. */
export const specPath = (layer: Layer) => `${SPECS_DIR}/${specSlug(layer)}.md`;

/** O pedido que o usuário cola no agente de código que preferir: o alvo é o arquivo, a validação fica no app. */
export function handoffPrompt(layer: Layer): string {
  return [
    `Implemente o que está especificado em ${specPath(layer)}.`,
    "Siga a definição, as restrições do projeto e os critérios de aceite do arquivo; os diagramas mostram o processo, as telas e os dados.",
    "Inclua testes que cubram os critérios de aceite, no padrão de testes do projeto.",
    "Não mude o arquivo de especificação: ele é gerado pelo Open Semantic.",
  ].join("\n");
}
