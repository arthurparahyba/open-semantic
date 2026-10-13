import type { ReactNode } from "react";

import type { Block } from "@open-semantic/protocol";

import { run } from "./client.js";

interface Props {
  block: Block;
  highlighted: boolean;
  onHeaderPointerDown(event: React.PointerEvent): void;
  onFocus(): void;
  onError(message: string): void;
}

/** Negrito (**x**) e código (`x`) dentro do texto; o resto fica como está. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    return part;
  });
}

function Content({ block }: { block: Block }) {
  if (block.kind === "list") {
    const items = (block.items ?? []).map((item, i) => <li key={i}>{inline(item)}</li>);
    return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
  }
  if (block.kind === "table") {
    return (
      <table>
        {block.columns?.length ? (
          <thead>
            <tr>{block.columns.map((c, i) => <th key={i}>{inline(c)}</th>)}</tr>
          </thead>
        ) : null}
        <tbody>
          {(block.rows ?? []).map((row, r) => (
            <tr key={r}>{(row as string[]).map((cell, c) => <td key={c}>{inline(cell)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    );
  }
  return null;
}

/**
 * Bloco de explicação no canvas (docs/funcionalidades/13-layout-semantico.md): título, texto, lista ou tabela.
 * Arrasta-se pelo bloco inteiro; os blocos colados a um diagrama andam junto com ele.
 */
export function BlockView({ block, highlighted, onHeaderPointerDown, onFocus, onError }: Props) {
  const remove = async () => {
    const result = await run("block.remove", { blockId: block.id });
    if (result.status !== "succeeded") onError(result.error?.message ?? "Não foi possível tirar o bloco.");
  };
  const Title = block.kind === "heading" ? "h2" : "h3";
  return (
    <section
      className={`block block-${block.kind}${highlighted ? " is-highlighted" : ""}`}
      data-testid="block"
      data-block-id={block.id}
      data-kind={block.kind}
      onPointerDown={onHeaderPointerDown}
      onDoubleClick={onFocus}
    >
      {block.title && <Title className="block-title">{inline(block.title)}</Title>}
      {block.text && <p className="block-text">{inline(block.text)}</p>}
      <Content block={block} />
      <button type="button" className="block-remove" onPointerDown={(e) => e.stopPropagation()} onClick={() => void remove()} aria-label="Tirar bloco" title="Tirar bloco">
        ×
      </button>
    </section>
  );
}
