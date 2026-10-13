import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BUILTIN_MODES, ModeRegistry } from "../src/modes/index.js";
import { ModeFileError, parseModeFile } from "../src/modes/file.js";
import { loadModeDir } from "../src/modes/load.js";

const REVIEW = `---
id: revisao
nome: Revisão de código
ativa-quando: revisar, code review, o que está errado
cadencia: etapas
proximos-passos: Próximo arquivo | Corrigir isto | Encerrar
---
Revise um arquivo por vez e marque no diagrama o que precisa mudar.
`;

describe("modos em arquivo", () => {
  it("o cabeçalho diz quando ativa e como interage; o corpo vira as instruções", () => {
    const mode = parseModeFile(REVIEW);
    expect(mode).toMatchObject({ id: "revisao", name: "Revisão de código", cadence: "steps", nextSteps: ["Próximo arquivo", "Corrigir isto", "Encerrar"] });
    expect(mode.instructions).toContain("Revise um arquivo por vez");
    expect(mode.activatesWhen("pode revisar o controller de pets?", {})).toBe(true);
    expect(mode.activatesWhen("O que está errado aqui?", {})).toBe(true);
    expect(mode.activatesWhen("explique a arquitetura", {})).toBe(false);
    expect(mode.activatesWhen("Corrigir isto", { previous: "revisao" })).toBe(true);
  });

  it("entra no mesmo registro e ganha dos modos do app", () => {
    const modes = new ModeRegistry(BUILTIN_MODES);
    modes.register(parseModeFile(REVIEW));
    expect(modes.pick("quero revisar o serviço de donos").id).toBe("revisao");
    expect(modes.pick("explique a arquitetura").id).toBe("breve");
  });

  it("arquivo sem cabeçalho, sem gatilho ou sem instruções é recusado com o motivo", () => {
    expect(() => parseModeFile("só texto")).toThrow(ModeFileError);
    expect(() => parseModeFile("---\nid: x\n---\nfaça algo")).toThrow(/ativa-quando/);
    expect(() => parseModeFile("---\nativa-quando: x\n---\n")).toThrow(/instruções/);
  });

  it("lê a pasta, ignora os arquivos ruins e diz por quê", async () => {
    const dir = await mkdtemp(join(tmpdir(), "modos-"));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "revisao.md"), REVIEW);
      await writeFile(join(dir, "ruim.md"), "sem cabeçalho");
      await writeFile(join(dir, "nota.txt"), "não é modo");
      const loaded = await loadModeDir(dir);
      expect(loaded.modes.map((m) => m.id)).toEqual(["revisao"]);
      expect(loaded.errors).toEqual([{ file: "ruim.md", message: expect.stringContaining("cabeçalho") }]);
      expect(await loadModeDir(join(dir, "nao-existe"))).toEqual({ modes: [], errors: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
