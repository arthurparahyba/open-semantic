// Modos de execução de uma pasta (*.md). O workspace usa .open-semantic/modes; a pasta do usuário virá depois.
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import type { ExecutionMode } from "./index.js";
import { parseModeFile } from "./file.js";

export interface LoadedModes {
  modes: ExecutionMode[];
  /** Arquivos que não viraram modo, com o motivo (o app avisa e segue com os outros). */
  errors: { file: string; message: string }[];
}

export async function loadModeDir(dir: string): Promise<LoadedModes> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return { modes: [], errors: [] };
  }
  const result: LoadedModes = { modes: [], errors: [] };
  for (const file of files) {
    try {
      result.modes.push(parseModeFile(await readFile(join(dir, file), "utf8"), basename(file, ".md")));
    } catch (err) {
      result.errors.push({ file, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
