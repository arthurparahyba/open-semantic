// Qual pasta é o workspace: escolhida pelo usuário na primeira abertura e lembrada nas configurações do app.
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class WorkspaceChoice {
  constructor(private readonly dataDir: string) {}

  private get file() {
    return join(this.dataDir, "workspace-choice.json");
  }

  /** Última pasta aberta, se ainda existir. */
  async recent(): Promise<string | undefined> {
    try {
      const { path } = JSON.parse(await readFile(this.file, "utf8")) as { path?: unknown };
      if (typeof path !== "string") return undefined;
      return (await stat(path).catch(() => undefined))?.isDirectory() ? path : undefined;
    } catch {
      return undefined;
    }
  }

  async remember(path: string) {
    await mkdir(this.dataDir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ path }, null, 2) + "\n", "utf8");
    await rename(tmp, this.file);
  }
}
