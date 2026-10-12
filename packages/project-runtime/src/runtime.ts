import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
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

  async listDir(artifactId: string, exclude: string[] = [".git", "node_modules"], actor?: Actor): Promise<DirEntry[]> {
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

async function fingerprint(abs: string, withHash: boolean): Promise<Fingerprint> {
  const info = await stat(abs);
  const fp: Fingerprint = { mtime: info.mtime.toISOString(), size: info.size };
  if (withHash && info.isFile()) fp.contentHash = hash(await readFile(abs));
  return fp;
}
