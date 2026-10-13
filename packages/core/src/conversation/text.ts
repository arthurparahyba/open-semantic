// Texto livre em formas comparáveis: para achar uma unidade pelo nome, reconhecer um pedido de explicação e montar ids.
import { createHash } from "node:crypto";

/** Minúsculas, sem acento, só letras e dígitos separados por espaço. */
export const normalized = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function hash(text: string, size = 8): string {
  return createHash("sha256").update(text).digest("hex").slice(0, size);
}

/** Texto livre em id legível: minúsculas, sem acento, só letras, dígitos e _. */
export function slug(text: string, max = 40): string {
  const s = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^(nd|sem|dgm|edg|rel|evd|prj)_/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max)
    .replace(/_+$/, "");
  return s.length >= 3 ? s : `${s || "x"}_${hash(text, 4)}`;
}
