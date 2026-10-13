// Operações do Semantic Navigator (docs/funcionalidades/04-semantic-navigator.md).
// Ficam fora do index para a interface poder importar a geometria sem levar o Workspace Store junto.
import { randomUUID } from "node:crypto";

import {
  OperationError,
  SCHEMA_BASE_URI,
  sameValue,
  type Camera,
  type DomainEvent,
  type FrameRequest,
  type HistoryEntry,
  type NavigationState,
  type OperationHandler,
  type OperationRequest,
  type Rect,
} from "@open-semantic/protocol";
import { contextGroups, unitItems, type WorkspaceStore } from "@open-semantic/workspace-store";

import { computeFrame, isVisible, type Viewport } from "./index.js";

const ref = (path: string) => ({ $ref: SCHEMA_BASE_URI + path });

/** Altura de um mod recolhido no canvas (só o cabeçalho). */
const COLLAPSED_HEIGHT = 40;
/** Margem, em pixels de tela, ao redor do que é enquadrado. */
const FRAME_PADDING = 64;
const HISTORY_LIMIT = 20;

export interface NavigatorDeps {
  store: WorkspaceStore;
  /** Tamanho atual da área do canvas na tela, informado pela interface. */
  viewport(): Viewport;
  now?: () => Date;
  newId?: (prefix: string) => string;
  onEvent?: (event: DomainEvent) => void;
  /** Duração da animação; ao fim, o movimento volta a `idle` e sai `navigation.completed`. */
  animationMs?: number;
}

interface Resolved {
  rects: Rect[];
  framedIds: string[];
  unresolved: string[];
}

/** O agente diz o que ver; aqui se resolve em quais retângulos isso se traduz no canvas. */
export function resolveTargets(store: WorkspaceStore, targets: FrameRequest["targets"]): Resolved {
  const doc = store.read();
  const out: Resolved = { rects: [], framedIds: [], unresolved: [] };
  const add = (id: string, rect: Rect) => {
    out.rects.push(rect);
    if (!out.framedIds.includes(id)) out.framedIds.push(id);
  };
  const objectRect = (id: string): Rect | undefined => {
    const o = doc.canvas.objects.find((x) => x.id === id);
    if (!o) return undefined;
    return { position: o.position, size: o.collapsed ? { width: o.size.width, height: COLLAPSED_HEIGHT } : o.size };
  };
  const nodeRect = (nodeId: string): Rect | undefined => {
    for (const d of doc.diagrams) {
      const r = d.layout.nodes[nodeId];
      const o = doc.canvas.objects.find((x) => x.id === d.id);
      if (r && o) return { position: { x: o.position.x + r.position.x, y: o.position.y + r.position.y }, size: r.size };
    }
    return undefined;
  };

  for (const id of targets.visualIds ?? []) {
    if (id.startsWith("rgn_")) {
      const region = store.region(id);
      if (region) add(id, region.bounds);
      else out.unresolved.push(id);
    } else if (id.startsWith("nd_")) {
      const r = nodeRect(id);
      if (r) add(id, r);
      else out.unresolved.push(id);
    } else if (id.startsWith("edg_")) {
      const diagram = doc.diagrams.find((d) => d.edges.some((e) => e.id === id));
      const edge = diagram?.edges.find((e) => e.id === id);
      const a = edge && nodeRect(edge.sourceNodeId);
      const b = edge && nodeRect(edge.targetNodeId);
      if (a && b) {
        out.rects.push(a, b);
        out.framedIds.push(id);
      } else out.unresolved.push(id);
    } else {
      const r = objectRect(id);
      if (r) add(id, r);
      else out.unresolved.push(id);
    }
  }

  if (targets.regionId) {
    const region = store.region(targets.regionId);
    if (region) {
      add(region.id, region.bounds);
      for (const o of doc.canvas.objects) if (o.regionId === region.id) add(o.id, objectRect(o.id)!);
    } else out.unresolved.push(targets.regionId);
  }

  // Uma unidade de contexto: tudo o que está ancorado nela ou dentro dela, e o grupo desenhado em volta (doc 09).
  const groups = targets.semanticEntityIds?.length ? new Map(contextGroups(doc).map((g) => [g.unitId, g])) : new Map();
  for (const entityId of targets.semanticEntityIds ?? []) {
    const before = out.rects.length;
    for (const id of unitItems(doc, entityId)) add(id, objectRect(id)!);
    const group = groups.get(entityId);
    if (group) add(entityId, group.bounds);
    for (const m of doc.mods) if (m.semanticEntityIds?.includes(entityId) && objectRect(m.id)) add(m.id, objectRect(m.id)!);
    for (const d of doc.diagrams) {
      for (const n of d.nodes) if (n.semanticEntityId === entityId && nodeRect(n.id)) add(n.id, nodeRect(n.id)!);
    }
    for (const r of doc.canvas.regions) if (r.semanticEntityIds?.includes(entityId)) add(r.id, r.bounds);
    if (out.rects.length === before) out.unresolved.push(entityId);
  }
  return out;
}

/** O usuário mexeu na câmera há pouco (user_hold ainda valendo) ou desligou a navegação automática? */
export function agentMayMove(nav: NavigationState, settings: { autoNavigate?: boolean }, now: Date): boolean {
  if (settings.autoNavigate === false) return false;
  if (nav.control.mode === "user_locked") return false;
  if (nav.control.mode === "user_hold" && nav.control.holdUntil && Date.parse(nav.control.holdUntil) > now.getTime()) return false;
  return true;
}

export function navigationHandlers(deps: NavigatorDeps): OperationHandler[] {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? ((prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`);
  const animationMs = deps.animationMs ?? 700;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const emit = (type: DomainEvent["type"], request: OperationRequest, payload: Record<string, unknown>) =>
    deps.onEvent?.({
      eventId: newId("evt"),
      type,
      source: "navigator",
      operationId: request.operationId,
      workspaceRevision: store.revision,
      payload,
      at: now().toISOString(),
    });

  const holdControl = (): NavigationState["control"] => {
    const nav = store.read().navigation;
    if (nav.control.mode === "user_locked") return nav.control;
    const ms = store.read().workspace.settings.userHoldMs ?? 4000;
    return { mode: "user_hold", holdUntil: new Date(now().getTime() + ms).toISOString() };
  };

  /** Interrompe um movimento em curso (o usuário mexeu na câmera). */
  const interrupt = (request: OperationRequest, camera?: Camera) => {
    const nav = store.read().navigation;
    const wasAnimating = nav.motion.status === "animating";
    store.updateNavigation({
      ...(camera ? { camera } : {}),
      motion: { status: "idle" },
      control: holdControl(),
    });
    if (wasAnimating && nav.motion.navigationId) {
      clearTimeout(timers.get(nav.motion.navigationId));
      timers.delete(nav.motion.navigationId);
      emit("navigation.cancelled", request, { navigationId: nav.motion.navigationId, origin: "user" });
    }
    return wasAnimating;
  };

  const frame = (request: OperationRequest, args: FrameRequest, resolved: Resolved) => {
    const actor = request.authorization.actor;
    const doc = store.read();
    const intent = args.intent ?? "focus";
    if (actor.kind !== "user" && !agentMayMove(doc.navigation, doc.workspace.settings, now())) {
      // Não move: a interface mostra a sugestão ("Ver arquitetura") e o usuário decide.
      return {
        output: { deferred: true, framedIds: resolved.framedIds, ...(args.reason ? { reason: args.reason } : {}) },
        changes: [{ id: store.id, change: "unchanged" as const }],
      };
    }
    const viewport = deps.viewport();
    const current = doc.navigation.camera;
    const alreadyVisible = intent !== "detail" && resolved.rects.every((r) => isVisible(r, current, viewport));
    if (alreadyVisible && actor.kind !== "user") {
      // A câmera fica onde está, mas o destaque muda: o assunto já está na tela e precisa aparecer.
      const focus = { targetIds: resolved.framedIds, ...(args.highlight !== false ? { highlightIds: resolved.framedIds } : {}) };
      const same = sameValue(focus, doc.navigation.focus);
      if (!same) store.transact(() => store.updateNavigation({ focus }));
      return {
        output: { deferred: false, unchanged: true, camera: current, framedIds: resolved.framedIds },
        changes: [{ id: store.id, change: same ? ("unchanged" as const) : ("updated" as const) }],
        ...(same ? {} : { workspaceRevision: store.revision }),
      };
    }
    const target = computeFrame(resolved.rects, viewport, { intent, padding: args.padding ?? FRAME_PADDING })!;
    const navigationId = newId("nav");
    const at = now().toISOString();
    const origin = actor.kind === "user" ? "user" : "agent";
    const animate = args.animate !== false;
    const entry: HistoryEntry = { camera: current, focus: doc.navigation.focus, origin, at };
    const history = [...doc.navigation.history, entry].slice(-HISTORY_LIMIT) as NavigationState["history"];
    const lastOverview =
      intent === "overview"
        ? target
        : intent === "detail" && current.zoom < target.zoom
          ? current
          : doc.navigation.lastOverview;
    store.transact(() =>
      store.updateNavigation({
        camera: target,
        focus: { targetIds: resolved.framedIds, ...(args.highlight !== false ? { highlightIds: resolved.framedIds } : {}) },
        history,
        ...(lastOverview ? { lastOverview } : {}),
        motion: animate ? { status: "animating", navigationId, origin, target, startedAt: at } : { status: "idle" },
      }),
    );
    emit("navigation.started", request, { navigationId, origin, ...(args.reason ? { reason: args.reason } : {}) });
    const complete = () => {
      timers.delete(navigationId);
      if (store.read().navigation.motion.navigationId !== navigationId) return;
      store.transact(() => store.updateNavigation({ motion: { status: "idle" } }));
      emit("navigation.completed", request, { navigationId });
    };
    if (animate) {
      for (const [id, timer] of timers) {
        clearTimeout(timer);
        timers.delete(id); // um novo frame substitui o anterior
      }
      timers.set(navigationId, setTimeout(complete, animationMs));
    } else complete();
    return {
      output: { navigationId, camera: target, framedIds: resolved.framedIds, deferred: false },
      changes: [{ id: store.id, change: "updated" as const }],
      workspaceRevision: store.revision,
    };
  };

  const checkTargets = (targets: FrameRequest["targets"]) => {
    const resolved = resolveTargets(store, targets);
    if (resolved.unresolved.length > 0 || resolved.rects.length === 0) {
      throw new OperationError("TARGET_NOT_FOUND", "Nada no canvas corresponde aos alvos pedidos.", {
        details: { unresolved: resolved.unresolved },
      });
    }
    return resolved;
  };

  return [
    {
      operation: "navigation.frame",
      argumentsSchema: ref("navigation.schema.json#/$defs/FrameRequest"),
      check: (args) => void checkTargets((args as unknown as FrameRequest).targets),
      handle(args, { request }) {
        const req = args as unknown as FrameRequest;
        return frame(request, req, checkTargets(req.targets));
      },
    },

    {
      // Volta a ver tudo: todos os objetos e regiões.
      operation: "navigation.overview",
      argumentsSchema: { type: "object", properties: { reason: { type: "string", maxLength: 200 } }, additionalProperties: false },
      check() {
        const doc = store.read();
        if (doc.canvas.objects.length + doc.canvas.regions.length === 0) {
          throw new OperationError("TARGET_NOT_FOUND", "O canvas está vazio.");
        }
      },
      handle(args, { request }) {
        const doc = store.read();
        const visualIds = [...doc.canvas.objects.map((o) => o.id), ...doc.canvas.regions.map((r) => r.id)];
        const req: FrameRequest = { targets: { visualIds: visualIds as [string, ...string[]] }, intent: "overview", highlight: false, ...(args.reason ? { reason: args.reason as string } : {}) };
        return frame(request, req, checkTargets(req.targets));
      },
    },

    {
      // O usuário interrompeu (Esc, clique, roda): para o movimento e segura a câmera por userHoldMs.
      operation: "navigation.cancel",
      argumentsSchema: {
        type: "object",
        properties: { navigationId: ref("common.schema.json#/$defs/NavigationId"), camera: ref("navigation.schema.json#/$defs/Camera") },
        additionalProperties: false,
      },
      handle(args, { request }) {
        const motion = store.read().navigation.motion;
        if (args.navigationId && motion.navigationId !== args.navigationId && !args.camera) {
          return { output: { cancelled: false }, changes: [{ id: store.id, change: "unchanged" }] };
        }
        const cancelled = store.transact(() =>
          request.authorization.actor.kind === "user"
            ? interrupt(request, args.camera as Camera | undefined)
            : (() => {
                const was = motion.status === "animating";
                store.updateNavigation({ motion: { status: "idle" } });
                return was;
              })(),
        );
        return { output: { cancelled }, changes: [{ id: store.id, change: "updated" }], workspaceRevision: store.revision };
      },
    },

    {
      // Câmera definida pelo usuário (pan/zoom). Também é o sinal de que ele assumiu o controle (user_hold).
      operation: "navigation.set_camera",
      argumentsSchema: {
        type: "object",
        required: ["camera"],
        properties: { camera: ref("navigation.schema.json#/$defs/Camera") },
        additionalProperties: false,
      },
      handle(args, { request }) {
        store.transact(() => {
          if (request.authorization.actor.kind === "user") interrupt(request, args.camera as Camera);
          else store.setCamera(args.camera as Camera);
        });
        if (request.authorization.actor.kind === "user") {
          emit("navigation.user_interacted", request, {});
        }
        return { changes: [{ id: store.id, change: "updated" }], workspaceRevision: store.revision };
      },
    },

    {
      // Só o usuário liga ou desliga a navegação automática (user_locked).
      operation: "navigation.set_control",
      argumentsSchema: {
        type: "object",
        required: ["mode"],
        properties: { mode: { enum: ["shared", "user_locked"] } },
        additionalProperties: false,
      },
      check(_args, { request }) {
        if (request.authorization.actor.kind !== "user") {
          throw new OperationError("UNAUTHORIZED", "Só o usuário controla a navegação automática.");
        }
      },
      handle(args) {
        const mode = args.mode as "shared" | "user_locked";
        if (store.read().navigation.control.mode === mode) return { changes: [{ id: store.id, change: "unchanged" }] };
        store.transact(() => store.updateNavigation({ control: { mode } }));
        return { output: { mode }, changes: [{ id: store.id, change: "updated" }], workspaceRevision: store.revision };
      },
    },
  ];
}
