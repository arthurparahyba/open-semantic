// O que o app aprende sobre um repositório mora dentro dele, em `.open-semantic/`:
// um arquivo por diagrama e um arquivo de conhecimento (entidades, relações, evidências).
// Assim quem clonar o repositório recebe tudo como contexto. O workspace guarda só referências e a disposição do canvas.
//
// Nos arquivos do repositório os artefatos aparecem pelo caminho relativo, não pelo id:
// ids de artefato são do workspace de cada pessoa; o caminho vale para qualquer um que clonar.
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { contractValidator, describeErrors } from "@open-semantic/protocol";
import type {
  ArtifactReference,
  CanvasObject,
  DiagramModel,
  Evidence,
  Project,
  SemanticEntity,
  SemanticRelation,
  WorkspaceSnapshot,
} from "@open-semantic/protocol";

import { contentSize } from "./diagramSize.js";
import { placeNew } from "./placement.js";

export const REPO_DIR = ".open-semantic";
const KNOWLEDGE_FILE = "knowledge.json";
const DIAGRAMS_DIR = "diagrams";

export type PortableEntity = Omit<SemanticEntity, "artifactIds"> & { artifactPaths?: string[] };
export type PortableEvidence = Omit<Evidence, "artifactId"> & { artifactPath?: string };

/** Conteúdo de um repositório, no formato que vai para os arquivos. */
export interface RepoContent {
  diagrams: Omit<DiagramModel, "projectId">[];
  entities: PortableEntity[];
  relations: SemanticRelation[];
  evidence: PortableEvidence[];
}

const isEmpty = (c: RepoContent) => !c.diagrams.length && !c.entities.length && !c.relations.length && !c.evidence.length;

/** O projeto guarda seu conhecimento no próprio repositório: pasta local com permissão de escrita. */
export function storesInRepo(project: Project): boolean {
  return project.location.kind === "local" && project.roots.some((r) => r.path === "" && r.capabilities.includes("write"));
}

const rootPathOf = (project: Project) => (project.location.kind === "local" ? project.location.rootPath : undefined);

/**
 * Separa o snapshot: o que pertence a cada repositório sai do workspace e vai para o repositório.
 * - diagrama do projeto P (projectId);
 * - entidade do projeto P; relação entre duas entidades de P;
 * - evidência sobre um arquivo de P, ou sem arquivo e citada só por itens de P.
 * O resto (o que liga projetos, ou não é de nenhum) fica no workspace.
 */
export function splitSnapshot(snapshot: WorkspaceSnapshot): { workspace: WorkspaceSnapshot; repos: Map<string, RepoContent> } {
  const workspace = structuredClone(snapshot);
  const repos = new Map<string, RepoContent>();
  const artifacts = new Map(snapshot.artifacts.map((a) => [a.id, a]));
  const pathOf = (id: string) => {
    const a = artifacts.get(id);
    return a && "rootId" in a.locator ? a.locator.path : undefined;
  };

  for (const project of snapshot.projects.filter(storesInRepo)) {
    const pid = project.id;
    const entityIds = new Set(snapshot.semantic.entities.filter((e) => e.projectId === pid).map((e) => e.id));
    const relations = snapshot.semantic.relations.filter((r) => entityIds.has(r.sourceId) && entityIds.has(r.targetId));
    const cited = new Set(
      [...snapshot.semantic.entities.filter((e) => entityIds.has(e.id)), ...relations].flatMap((x) => x.provenance.evidenceIds ?? []),
    );
    const citedElsewhere = new Set(
      [...snapshot.semantic.entities.filter((e) => !entityIds.has(e.id)), ...snapshot.semantic.relations.filter((r) => !relations.includes(r))].flatMap(
        (x) => x.provenance.evidenceIds ?? [],
      ),
    );
    const evidence = snapshot.semantic.evidence.filter((ev) =>
      ev.artifactId ? artifacts.get(ev.artifactId)?.projectId === pid : cited.has(ev.id) && !citedElsewhere.has(ev.id),
    );
    const diagrams = snapshot.diagrams.filter((d) => d.projectId === pid);

    const content: RepoContent = {
      diagrams: diagrams.map(({ projectId: _p, ...d }) => d),
      entities: snapshot.semantic.entities
        .filter((e) => entityIds.has(e.id))
        .map(({ artifactIds, ...e }) => {
          const paths = (artifactIds ?? []).map(pathOf).filter((p): p is string => p !== undefined);
          return artifactIds ? { ...e, artifactPaths: paths } : e;
        }),
      relations,
      evidence: evidence.map(({ artifactId, ...ev }) => {
        const path = artifactId ? pathOf(artifactId) : undefined;
        return path !== undefined ? { ...ev, artifactPath: path } : ev;
      }),
    };
    repos.set(pid, content);

    const goneDiagrams = new Set(diagrams.map((d) => d.id));
    const goneRelations = new Set(relations.map((r) => r.id));
    const goneEvidence = new Set(evidence.map((e) => e.id));
    workspace.diagrams = workspace.diagrams.filter((d) => !goneDiagrams.has(d.id));
    workspace.semantic.entities = workspace.semantic.entities.filter((e) => !entityIds.has(e.id));
    workspace.semantic.relations = workspace.semantic.relations.filter((r) => !goneRelations.has(r.id));
    workspace.semantic.evidence = workspace.semantic.evidence.filter((e) => !goneEvidence.has(e.id));
  }
  return { workspace, repos };
}

const validators = {
  diagram: contractValidator("diagram.schema.json#/$defs/DiagramModel"),
  entity: contractValidator("semantic.schema.json#/$defs/SemanticEntity"),
  relation: contractValidator("semantic.schema.json#/$defs/SemanticRelation"),
  evidence: contractValidator("semantic.schema.json#/$defs/Evidence"),
};
// Os arquivos do repositório não levam projectId nem ids de artefato; para validar, entram valores provisórios.
const PROBE_PROJECT = "prj_repo";
const PROBE_ARTIFACT = "art_repo_probe";

/**
 * Lê `.open-semantic/` de um repositório. Cada item é conferido com o contrato: o que estiver fora
 * (arquivo editado à mão, versão nova do app) é pulado e informado em `problems`, sem impedir de abrir o resto.
 */
export async function readRepoContent(rootPath: string): Promise<{ content: RepoContent; problems: string[] }> {
  const dir = join(rootPath, REPO_DIR);
  const content: RepoContent = { diagrams: [], entities: [], relations: [], evidence: [] };
  const problems: string[] = [];
  const keep = <T>(where: string, list: unknown, check: (item: T) => boolean, errors: () => unknown): T[] =>
    (Array.isArray(list) ? (list as T[]) : []).filter((item, i) => {
      if (check(item)) return true;
      problems.push(`${where}[${i}] fora do contrato: ${describeErrors(errors() as never)}`);
      return false;
    });
  try {
    const knowledge = JSON.parse(await readFile(join(dir, KNOWLEDGE_FILE), "utf8")) as Partial<RepoContent>;
    content.entities = keep<PortableEntity>(
      `${KNOWLEDGE_FILE} entities`,
      knowledge.entities,
      ({ artifactPaths, ...e }) =>
        validators.entity({ ...e, projectId: PROBE_PROJECT, ...(artifactPaths ? { artifactIds: artifactPaths.map(() => PROBE_ARTIFACT) } : {}) }) &&
        (artifactPaths ?? []).every((p) => typeof p === "string"),
      () => validators.entity.errors,
    );
    content.relations = keep<SemanticRelation>(`${KNOWLEDGE_FILE} relations`, knowledge.relations, (r) => validators.relation(r), () => validators.relation.errors);
    content.evidence = keep<PortableEvidence>(
      `${KNOWLEDGE_FILE} evidence`,
      knowledge.evidence,
      ({ artifactPath, ...ev }) => validators.evidence({ ...ev, ...(typeof artifactPath === "string" ? { artifactId: PROBE_ARTIFACT } : {}) }),
      () => validators.evidence.errors,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${KNOWLEDGE_FILE}: ${(err as Error).message}`);
  }
  let files: string[] = [];
  try {
    files = (await readdir(join(dir, DIAGRAMS_DIR))).filter((f) => f.endsWith(".json")).sort();
  } catch {
    // sem diagramas
  }
  for (const file of files) {
    try {
      const { format: _f, version: _v, ...diagram } = JSON.parse(await readFile(join(dir, DIAGRAMS_DIR, file), "utf8")) as Omit<DiagramModel, "projectId"> & {
        format?: string;
        version?: number;
      };
      if (!validators.diagram({ ...diagram, projectId: PROBE_PROJECT })) {
        problems.push(`${DIAGRAMS_DIR}/${file} fora do contrato: ${describeErrors(validators.diagram.errors)}`);
        continue;
      }
      content.diagrams.push(diagram);
    } catch (err) {
      problems.push(`${DIAGRAMS_DIR}/${file}: ${(err as Error).message}`);
    }
  }
  return { content, problems };
}

export type PathKinds = Map<string, "file" | "directory" | undefined>;

/** Descobre no disco o tipo de cada caminho citado (undefined: não existe). Feito antes do merge, que é síncrono. */
export async function statPaths(rootPath: string | undefined, content: RepoContent): Promise<PathKinds> {
  const paths = new Set([...content.entities.flatMap((e) => e.artifactPaths ?? []), ...content.evidence.flatMap((e) => (e.artifactPath !== undefined ? [e.artifactPath] : []))]);
  const kinds: PathKinds = new Map();
  for (const path of paths) {
    const info = rootPath ? await stat(join(rootPath, path)).catch(() => undefined) : undefined;
    kinds.set(path, info ? (info.isDirectory() ? "directory" : "file") : undefined);
  }
  return kinds;
}

export const rootPathOfProject = (project: Project) => rootPathOf(project);

/**
 * Junta ao snapshot o que veio do repositório. O repositório vale mais que o workspace para os mesmos ids.
 * Caminhos viram artefatos do workspace (criados se preciso). Diagramas sem lugar no canvas ganham um.
 */
export function mergeRepoContent(
  doc: WorkspaceSnapshot,
  project: Project,
  content: RepoContent,
  kinds: PathKinds,
  options: { now: () => Date; newArtifactId: (path: string) => string },
): void {
  const rootId = project.roots[0].id;
  const artifactFor = (path: string): string => {
    const existing = doc.artifacts.find((a) => a.projectId === project.id && "rootId" in a.locator && a.locator.rootId === rootId && a.locator.path === path);
    if (existing) return existing.id;
    const kind = kinds.get(path);
    const info = kind ? { isDirectory: () => kind === "directory" } : undefined;
    const checkedAt = options.now().toISOString();
    const artifact: ArtifactReference = {
      id: options.newArtifactId(path),
      projectId: project.id,
      kind: info?.isDirectory() ? "directory" : "file",
      locator: { rootId, path },
      validity: info ? { status: "valid", checkedAt } : { status: "missing", checkedAt, reason: "Citado no conhecimento do repositório, mas não existe." },
      provenance: { source: "inspection", actor: { kind: "system", id: "repo_store" }, recordedAt: checkedAt },
    };
    doc.artifacts.push(artifact);
    return artifact.id;
  };

  const replace = <T extends { id: string }>(list: T[], items: T[]) => {
    const ids = new Set(items.map((i) => i.id));
    return [...list.filter((x) => !ids.has(x.id)), ...items];
  };

  const entities: SemanticEntity[] = [];
  for (const { artifactPaths, ...e } of content.entities) {
    const artifactIds = [];
    for (const p of artifactPaths ?? []) artifactIds.push(artifactFor(p));
    entities.push({ ...e, projectId: project.id, ...(artifactPaths ? { artifactIds } : {}) } as SemanticEntity);
  }
  const evidence: Evidence[] = [];
  for (const { artifactPath, ...ev } of content.evidence) {
    evidence.push({ ...ev, ...(artifactPath !== undefined ? { artifactId: artifactFor(artifactPath) } : {}) } as Evidence);
  }
  doc.semantic.entities = replace(doc.semantic.entities, entities);
  doc.semantic.relations = replace(doc.semantic.relations, content.relations);
  doc.semantic.evidence = replace(doc.semantic.evidence, evidence);
  doc.diagrams = replace(
    doc.diagrams,
    content.diagrams.map((d) => ({ ...d, projectId: project.id }) as DiagramModel),
  );

  for (const d of content.diagrams) {
    if (doc.canvas.objects.some((o) => o.id === d.id)) continue;
    const size = contentSize(d.layout);
    const { rect, regionId } = placeNew(doc, size, {});
    const object: CanvasObject = { id: d.id, objectKind: "diagram", position: rect.position, size: rect.size, placedBy: "agent", ...(regionId ? { regionId } : {}) };
    doc.canvas.objects.push(object);
  }
}

/**
 * Grava o conteúdo de um repositório. Só escreve arquivos que mudaram (para não sujar o `git status`)
 * e só apaga diagramas que este app gravou ou leu antes (um arquivo novo vindo de um `git pull` fica).
 */
export class RepoWriter {
  /** Por caminho absoluto: o texto que está no disco, segundo a última leitura ou escrita deste app. */
  private readonly known = new Map<string, string>();

  /** Registra o que foi lido ao abrir, para comparar e para saber o que pode ser apagado. */
  remember(rootPath: string, content: RepoContent) {
    for (const [file, text] of this.render(rootPath, content)) this.known.set(file, text);
  }

  async write(rootPath: string, content: RepoContent): Promise<string[]> {
    const written: string[] = [];
    const files = this.render(rootPath, content);
    const diagramsDir = join(rootPath, REPO_DIR, DIAGRAMS_DIR);
    // Arquivos deste repositório que o app conhece e que não existem mais no conteúdo: diagrama excluído.
    for (const file of [...this.known.keys()]) {
      if (file.startsWith(diagramsDir) && !files.has(file)) {
        await rm(file, { force: true });
        this.known.delete(file);
        written.push(file);
      }
    }
    if (isEmpty(content) && ![...this.known.keys()].some((f) => f.startsWith(join(rootPath, REPO_DIR)))) return written;
    for (const [file, text] of files) {
      if (this.known.get(file) === text) continue;
      await mkdir(join(file, ".."), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, text, "utf8");
      await rename(tmp, file);
      this.known.set(file, text);
      written.push(file);
    }
    return written;
  }

  private render(rootPath: string, content: RepoContent): Map<string, string> {
    const dir = join(rootPath, REPO_DIR);
    const files = new Map<string, string>();
    const idOf = (x: unknown) => String((x as { id: string }).id);
    const byId = <T,>(list: T[]) => [...list].sort((a, b) => idOf(a).localeCompare(idOf(b)));
    if (content.entities.length || content.relations.length || content.evidence.length || this.known.has(join(dir, KNOWLEDGE_FILE))) {
      files.set(
        join(dir, KNOWLEDGE_FILE),
        JSON.stringify(
          { format: "open-semantic/knowledge", version: 1, entities: byId(content.entities), relations: byId(content.relations), evidence: byId(content.evidence) },
          null,
          2,
        ) + "\n",
      );
    }
    for (const d of content.diagrams) {
      files.set(join(dir, DIAGRAMS_DIR, `${d.id}.json`), JSON.stringify({ format: "open-semantic/diagram", version: 1, ...d }, null, 2) + "\n");
    }
    return files;
  }
}
