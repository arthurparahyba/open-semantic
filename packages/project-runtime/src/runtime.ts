import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import {
  OperationError,
  contractValidator,
  type Actor,
  type ArtifactReference,
  type Capability,
  type Fingerprint,
  type Project,
} from "@open-semantic/protocol";
import { suffixOf, type WorkspaceStore } from "@open-semantic/workspace-store";

const validPath = contractValidator("common.schema.json#/$defs/ProjectRelativePath");

export interface DirEntry {
  artifactId: string;
  name: string;
  path: string;
  kind: "directory" | "file";
}

export interface CommandResult {
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  /** O fim da saída (stdout e stderr juntos), onde ficam os resultados dos testes. */
  output: string;
  truncated: boolean;
}

const MAX_COMMAND_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 8_000;

export interface RuntimeOptions {
  now?: () => Date;
  newId?: (prefix: string) => string;
  /** Limite de leitura de arquivos (padrão 2 MB). */
  maxReadBytes?: number;
}

/**
 * Único componente que toca arquivos reais (docs/funcionalidades/07-project-runtime.md).
 * Tudo passa por raízes autorizadas; referências são ArtifactReference com id estável.
 */
export class ProjectRuntime {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly maxReadBytes: number;

  constructor(
    private readonly store: WorkspaceStore,
    options: RuntimeOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`);
    this.maxReadBytes = options.maxReadBytes ?? 2 * 1024 * 1024;
  }

  /** Caminho relativo → ArtifactReference (reutiliza a existente para o mesmo caminho). */
  async resolve(
    projectId: string,
    rootId: string,
    path: string,
    actor: Actor,
    operationId?: string,
  ): Promise<ArtifactReference> {
    const { project } = this.rootOf(projectId, rootId, "read");
    const normalized = normalize(path);
    const abs = await this.safeAbsolute(project, rootId, normalized, { mustExist: true });
    const info = await stat(abs);
    const kind = info.isDirectory() ? "directory" : "file";
    const existing = this.store.findArtifact(projectId, rootId, normalized);
    const artifact: ArtifactReference = existing
      ? { ...existing, kind, validity: { status: "valid", checkedAt: this.now().toISOString() } }
      : {
          id: `art_${suffixOf(projectId)}_${this.newId("x").slice(2)}`,
          projectId,
          kind,
          locator: { rootId, path: normalized },
          validity: { status: "valid", checkedAt: this.now().toISOString() },
          provenance: {
            source: "inspection",
            actor,
            ...(operationId ? { operationId } : {}),
            recordedAt: this.now().toISOString(),
          },
        };
    if (!existing || existing.kind !== kind || existing.validity.status !== "valid") {
      this.store.transact(() => this.store.upsertArtifact(artifact));
    }
    return artifact;
  }

  /**
   * Cria um diretório (e os intermediários) dentro da raiz. Se já existe, devolve o artefato existente
   * com `created: false`: a operação é idempotente pelo caminho.
   */
  async createDir(
    projectId: string,
    rootId: string,
    path: string,
    actor: Actor,
    operationId?: string,
  ): Promise<{ artifact: ArtifactReference; created: boolean }> {
    const { project } = this.rootOf(projectId, rootId, "write");
    const normalized = normalize(path);
    if (normalized === "") {
      throw new OperationError("INVALID_ARGUMENTS", "Informe o caminho do diretório a criar.", { argumentPath: "/path" });
    }
    const existing = await this.safeAbsolute(project, rootId, normalized, { mustExist: true }).catch((err: unknown) => {
      if (err instanceof OperationError && err.code === "TARGET_NOT_FOUND") return undefined;
      throw err;
    });
    if (existing) {
      if (!(await stat(existing)).isDirectory()) {
        throw new OperationError("PRECONDITION_FAILED", `'${normalized}' já existe e não é um diretório.`, { argumentPath: "/path" });
      }
      return { artifact: await this.resolve(projectId, rootId, normalized, actor, operationId), created: false };
    }
    // Cria a partir do ancestral mais próximo que existe, validado antes de qualquer efeito: um link no
    // meio do caminho que aponte para fora da raiz recusa o pedido sem criar nada lá fora.
    const segments = normalized.split("/");
    const existingAncestor = (depth: number) =>
      this.safeAbsolute(project, rootId, segments.slice(0, depth).join("/"), { mustExist: true }).catch((err: unknown) => {
        if (err instanceof OperationError && err.code === "TARGET_NOT_FOUND") return undefined;
        throw err;
      });
    // Na profundidade 0 está a raiz: ela existe ou safeAbsolute lança, então o laço termina.
    let depth = segments.length - 1;
    let current = await existingAncestor(depth);
    while (!current) current = await existingAncestor(--depth);
    // Um segmento por vez, sem `recursive`: um link que apareça no caminho faz o mkdir falhar em vez de segui-lo.
    for (const segment of segments.slice(depth)) {
      const dir = join(current, segment);
      await mkdir(dir).catch(async (err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST" || !(await lstat(dir)).isDirectory()) throw err;
      });
      current = dir;
    }
    const at = this.now().toISOString();
    const artifact: ArtifactReference = {
      id: this.store.findArtifact(projectId, rootId, normalized)?.id ?? `art_${suffixOf(projectId)}_${this.newId("x").slice(2)}`,
      projectId,
      kind: "directory",
      locator: { rootId, path: normalized },
      validity: { status: "valid", checkedAt: at },
      provenance: { source: "execution", actor, ...(operationId ? { operationId } : {}), recordedAt: at },
    };
    this.store.transact(() => this.store.upsertArtifact(artifact));
    return { artifact, created: true };
  }

  /** Revalida um artefato e devolve validade + fingerprint, sem lançar se ele sumiu. */
  async stat(artifactId: string): Promise<ArtifactReference["validity"]> {
    const { artifact, project, rootId, path } = this.locate(artifactId);
    const checkedAt = this.now().toISOString();
    let validity: ArtifactReference["validity"];
    try {
      const abs = await this.safeAbsolute(project, rootId, path, { mustExist: true });
      validity = { status: "valid", checkedAt, fingerprint: await fingerprint(abs, artifact.kind === "file") };
    } catch (err) {
      const code = err instanceof OperationError ? err.code : "INTERNAL";
      validity = {
        status: code === "PATH_OUTSIDE_ROOT" ? "outside_root" : code === "TARGET_NOT_FOUND" ? "missing" : "inaccessible",
        checkedAt,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    if (validity.status !== artifact.validity.status) {
      this.store.transact(() => this.store.upsertArtifact({ ...artifact, validity }));
    }
    return validity;
  }

  async listDir(artifactId: string, exclude: string[] = [".git", "node_modules", ".open-semantic"], actor?: Actor): Promise<DirEntry[]> {
    const { artifact, project, rootId, path } = this.locate(artifactId, "read");
    if (artifact.kind !== "directory") {
      throw new OperationError("INVALID_ARGUMENTS", "O artefato não é um diretório.", { targetId: artifactId });
    }
    const abs = await this.safeAbsolute(project, rootId, path, { mustExist: true });
    const dirents = await readdir(abs, { withFileTypes: true });
    const entries: DirEntry[] = [];
    const toRegister: ArtifactReference[] = [];
    const checkedAt = this.now().toISOString();
    for (const d of dirents) {
      if (exclude.includes(d.name)) continue;
      const childPath = path ? `${path}/${d.name}` : d.name;
      let kind: "directory" | "file";
      if (d.isSymbolicLink()) {
        // Links só são listados se apontarem para dentro da raiz.
        try {
          const target = await this.safeAbsolute(project, rootId, childPath, { mustExist: true });
          kind = (await stat(target)).isDirectory() ? "directory" : "file";
        } catch {
          continue;
        }
      } else if (d.isDirectory()) kind = "directory";
      else if (d.isFile()) kind = "file";
      else continue;
      const existing = this.store.findArtifact(project.id, rootId, childPath);
      const id = existing?.id ?? `art_${suffixOf(project.id)}_${this.newId("x").slice(2)}`;
      if (!existing || existing.kind !== kind || existing.validity.status !== "valid") {
        toRegister.push({
          ...(existing ?? {
            id,
            projectId: project.id,
            locator: { rootId, path: childPath },
            provenance: {
              source: "inspection",
              actor: actor ?? { kind: "system", id: "project_runtime" },
              recordedAt: checkedAt,
            },
          }),
          kind,
          validity: { status: "valid", checkedAt },
        } as ArtifactReference);
      }
      entries.push({ artifactId: id, name: d.name, path: childPath, kind });
    }
    if (toRegister.length) this.store.transact(() => toRegister.forEach((a) => this.store.upsertArtifact(a)));
    return entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
  }

  async readFile(artifactId: string): Promise<{ content: string; fingerprint: Fingerprint }> {
    const { artifact, project, rootId, path } = this.locate(artifactId, "read");
    if (artifact.kind !== "file") {
      throw new OperationError("INVALID_ARGUMENTS", "O artefato não é um arquivo.", { targetId: artifactId });
    }
    const abs = await this.safeAbsolute(project, rootId, path, { mustExist: true });
    const info = await stat(abs);
    if (info.size > this.maxReadBytes) {
      throw new OperationError("INVALID_ARGUMENTS", `Arquivo grande demais para abrir (${info.size} bytes).`, {
        targetId: artifactId,
      });
    }
    const data = await readFile(abs);
    return {
      content: data.toString("utf8"),
      fingerprint: { mtime: info.mtime.toISOString(), size: info.size, contentHash: hash(data) },
    };
  }

  /**
   * Grava conteúdo. Com expectedHash, recusa se o arquivo mudou desde a leitura
   * (EXTERNAL_CHANGE_CONFLICT) em vez de sobrescrever em silêncio (V0.1 §4.1 regra 4).
   */
  async writeFile(artifactId: string, content: string, expectedHash?: string): Promise<Fingerprint> {
    const { artifact, project, rootId, path } = this.locate(artifactId, "write");
    if (artifact.kind !== "file") {
      throw new OperationError("INVALID_ARGUMENTS", "O artefato não é um arquivo.", { targetId: artifactId });
    }
    const abs = await this.safeAbsolute(project, rootId, path, { mustExist: false });
    if (expectedHash !== undefined) {
      const current = await fingerprint(abs, true).catch(() => undefined);
      if (current?.contentHash !== expectedHash) {
        throw new OperationError("EXTERNAL_CHANGE_CONFLICT", "O arquivo mudou fora do editor desde que foi aberto.", {
          targetId: artifactId,
          retryable: false,
          details: { current: current ?? null },
        });
      }
    }
    await writeFile(abs, content, "utf8");
    const fp = await fingerprint(abs, true);
    this.store.transact(() =>
      this.store.upsertArtifact({ ...artifact, validity: { status: "valid", checkedAt: this.now().toISOString(), fingerprint: fp } }),
    );
    return fp;
  }

  /**
   * Cria um arquivo novo (e as pastas do caminho). Recusa se o arquivo já existe: para mudar um arquivo
   * existente, o caminho é project.write_file com o hash lido.
   */
  async createFile(
    { projectId, rootId, path }: { projectId: string; rootId: string; path: string },
    content: string,
    { actor, operationId }: { actor: Actor; operationId?: string },
  ): Promise<{ artifact: ArtifactReference; fingerprint: Fingerprint }> {
    const { project } = this.rootOf(projectId, rootId, "write");
    const normalized = normalize(path);
    const slash = normalized.lastIndexOf("/");
    if (slash > 0) await this.createDir(projectId, rootId, normalized.slice(0, slash), actor, operationId);
    const abs = await this.safeAbsolute(project, rootId, normalized, { mustExist: false });
    await writeFile(abs, content, { encoding: "utf8", flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "EEXIST") throw new OperationError("PRECONDITION_FAILED", `'${normalized}' já existe; use project.write_file.`, { argumentPath: "/path" });
      throw err;
    });
    const artifact = await this.resolve(projectId, rootId, normalized, actor, operationId);
    return { artifact, fingerprint: await fingerprint(abs, true) };
  }

  /**
   * Roda um comando na raiz (ou numa pasta dela) e devolve o código de saída e o fim da saída.
   * Quem decide se pode é a política de comandos da raiz: deny_all recusa; nos outros modos o agente
   * só chega aqui depois de o usuário aprovar o comando exato no cartão de confirmação.
   */
  async runCommand(projectId: string, rootId: string, command: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<CommandResult> {
    const { project, root } = this.rootOf(projectId, rootId);
    const mode = root.commandPolicy?.mode ?? "confirm_all";
    if (mode === "deny_all") throw new OperationError("UNAUTHORIZED", `A raiz ${rootId} não executa comandos.`, { targetId: rootId });
    if (mode !== "confirm_all" && !root.capabilities.includes("execute")) {
      throw new OperationError("UNAUTHORIZED", `A raiz ${rootId} não concede 'execute'.`, { targetId: rootId });
    }
    const cwd = await this.safeAbsolute(project, rootId, normalize(opts.cwd ?? ""), { mustExist: true });
    const timeoutMs = Math.min(opts.timeoutMs ?? 120_000, MAX_COMMAND_MS);
    const started = Date.now();
    return new Promise((resolvePromise, reject) => {
      // Grupo próprio: no tempo limite, o shell e tudo o que ele abriu (mvn, java, node) param juntos.
      const child = spawn(command, { cwd, shell: true, env: process.env, windowsHide: true, detached: process.platform !== "win32" });
      let output = "";
      const keep = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-MAX_OUTPUT_CHARS * 2);
      };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new OperationError("INTERNAL", `Não consegui rodar o comando: ${err.message}`, { retryable: false }));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const truncated = output.length > MAX_OUTPUT_CHARS;
        resolvePromise({ exitCode: code ?? -1, timedOut, durationMs: Date.now() - started, output: truncated ? output.slice(-MAX_OUTPUT_CHARS) : output, truncated });
      });
    });
  }

  /** Pré-condição artifact_unchanged: compara o hash atual com o esperado. */
  async isUnchanged(artifactId: string, expected: Fingerprint): Promise<boolean> {
    const { project, rootId, path, artifact } = this.locate(artifactId);
    const abs = await this.safeAbsolute(project, rootId, path, { mustExist: true });
    const current = await fingerprint(abs, artifact.kind === "file");
    if (expected.contentHash) return current.contentHash === expected.contentHash;
    return current.mtime === expected.mtime && current.size === expected.size;
  }

  // ---------- segurança de caminhos ----------

  private rootOf(projectId: string, rootId: string, capability?: Capability) {
    const project = this.store.project(projectId);
    if (!project) throw new OperationError("TARGET_NOT_FOUND", `Projeto ${projectId} não existe.`, { targetId: projectId });
    const root = project.roots.find((r) => r.id === rootId);
    if (!root) throw new OperationError("PATH_OUTSIDE_ROOT", `Raiz ${rootId} não está autorizada.`, { targetId: rootId });
    if (capability && !root.capabilities.includes(capability)) {
      throw new OperationError("UNAUTHORIZED", `A raiz ${rootId} não concede '${capability}'.`, { targetId: rootId });
    }
    return { project, root };
  }

  private locate(artifactId: string, capability?: Capability) {
    const artifact = this.store.artifact(artifactId);
    if (!artifact || !("rootId" in artifact.locator)) {
      throw new OperationError("REFERENCE_INVALID", `Artefato ${artifactId} não existe.`, { targetId: artifactId });
    }
    const { project } = this.rootOf(artifact.projectId, artifact.locator.rootId, capability);
    return { artifact, project, rootId: artifact.locator.rootId, path: artifact.locator.path };
  }

  /**
   * Caminho absoluto garantidamente dentro da raiz, inclusive depois de resolver links simbólicos.
   * O caminho absoluto nunca sai deste módulo.
   */
  private async safeAbsolute(project: Project, rootId: string, path: string, opts: { mustExist: boolean }) {
    if (!validPath(path)) {
      throw new OperationError("PATH_OUTSIDE_ROOT", "Caminho precisa ser relativo à raiz, sem '..'.", {
        argumentPath: "/path",
      });
    }
    if (project.location.kind !== "local") {
      throw new OperationError("CAPABILITY_NOT_SUPPORTED", "Projetos remotos ainda não são suportados.");
    }
    const root = project.roots.find((r) => r.id === rootId)!;
    const rootAbs = await realpath(join(project.location.rootPath, root.path)).catch(() => {
      throw new OperationError("REFERENCE_INVALID", "A pasta do projeto não existe mais.", { targetId: project.id });
    });
    const target = join(rootAbs, ...path.split("/").filter(Boolean));
    let resolved: string;
    try {
      resolved = await realpath(target);
    } catch {
      if (opts.mustExist) throw new OperationError("TARGET_NOT_FOUND", `'${path}' não existe.`, { argumentPath: "/path" });
      // Arquivo novo: o diretório pai precisa existir e estar dentro da raiz.
      const parent = await realpath(dirname(target)).catch(() => {
        throw new OperationError("TARGET_NOT_FOUND", `O diretório de '${path}' não existe.`);
      });
      assertInside(rootAbs, parent);
      if ((await lstat(target).catch(() => undefined))?.isSymbolicLink()) {
        throw new OperationError("PATH_OUTSIDE_ROOT", "Link simbólico quebrado.");
      }
      return target;
    }
    assertInside(rootAbs, resolved);
    return resolved;
  }
}

function assertInside(rootAbs: string, candidate: string) {
  const rel = relative(rootAbs, candidate);
  if (rel === "") return;
  if (rel.startsWith("..") || rel.split(sep)[0] === ".." || rel.startsWith(sep)) {
    throw new OperationError("PATH_OUTSIDE_ROOT", "O caminho aponta para fora da raiz autorizada.");
  }
}

/** Remove "./" iniciais e "/" finais. Segmentos ".." não são tocados: a validação os recusa. */
function normalize(path: string): string {
  const trimmed = path.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return trimmed === "." ? "" : trimmed;
}

function hash(data: Buffer): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

function killTree(pid: number | undefined) {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // já terminou
  }
}

async function fingerprint(abs: string, withHash: boolean): Promise<Fingerprint> {
  const info = await stat(abs);
  const fp: Fingerprint = { mtime: info.mtime.toISOString(), size: info.size };
  if (withHash && info.isFile()) fp.contentHash = hash(await readFile(abs));
  return fp;
}
