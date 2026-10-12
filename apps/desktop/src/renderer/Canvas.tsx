import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";

import { computeFrame, pan, zoomAt, type FrameOptions, type Viewport } from "@open-semantic/navigator";
import { contextGroups } from "@open-semantic/workspace-store/anchoring";
import type { Camera, CanvasObject, Point, Rect, WorkspaceSnapshot } from "@open-semantic/protocol";

import { api, run } from "./client.js";

export interface CanvasHandle {
  /** Enquadra os objetos (todos, se ids vazio) com animação. */
  frame(ids?: string[], intent?: FrameOptions["intent"]): void;
  zoomBy(factor: number): void;
  viewportCenter(): Point;
}

export interface ObjectRenderProps {
  object: CanvasObject;
  zoom: number;
  highlighted: boolean;
  /** Ids destacados pelo último enquadramento (inclui nós de diagrama). */
  highlightIds: ReadonlySet<string>;
  onHeaderPointerDown(event: React.PointerEvent): void;
  onResizePointerDown(event: React.PointerEvent): void;
}

interface Props {
  snapshot: WorkspaceSnapshot;
  handle: Ref<CanvasHandle>;
  renderObject(props: ObjectRenderProps): ReactNode;
  onZoomChange?(zoom: number): void;
}

type Gesture =
  | { kind: "pan"; last: Point }
  | { kind: "move" | "resize"; id: string; start: Point; origin: Rect; rect?: Rect };

const MIN_SIZE = { width: 220, height: 120 };
const HIGHLIGHT_MS = 2600;

const sameCamera = (a: Camera, b: Camera) =>
  Math.abs(a.zoom - b.zoom) < 1e-4 && Math.abs(a.center.x - b.center.x) < 0.5 && Math.abs(a.center.y - b.center.y) < 0.5;

/**
 * Canvas infinito: câmera (pan/zoom), regiões, objetos posicionados no mundo e gestos do usuário.
 * Movimentos pedidos pelo agente chegam pelo snapshot (navigation.motion) e são animados aqui;
 * qualquer gesto do usuário durante a animação a interrompe e avisa o núcleo (navigation.cancel).
 */
export function Canvas({ snapshot, handle, renderObject, onZoomChange }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ width: 1, height: 1 });
  const [camera, setCameraState] = useState<Camera>(snapshot.navigation.camera);
  const cameraRef = useRef(camera);
  const gesture = useRef<Gesture | null>(null);
  const animation = useRef<number | null>(null);
  /** Movimento do núcleo em curso (pedido pelo agente ou por uma sugestão). */
  const coreMotion = useRef<string | null>(null);
  const lastSent = useRef<Camera>(snapshot.navigation.camera);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [highlight, setHighlight] = useState<string[]>([]);
  // Posições locais durante arrasto, até o núcleo confirmar a nova revisão.
  const [overrides, setOverrides] = useState<Record<string, { rect: Rect; revision: number }>>({});

  const sendCamera = () => {
    lastSent.current = cameraRef.current;
    void run("navigation.set_camera", { camera: cameraRef.current });
  };

  const setCamera = useCallback(
    (next: Camera, persist = true) => {
      cameraRef.current = next;
      setCameraState(next);
      onZoomChange?.(next.zoom);
      if (!persist) return;
      // O primeiro movimento vai na hora (o núcleo passa a segurar a câmera para o usuário);
      // os seguintes são agrupados.
      if (saveTimer.current) clearTimeout(saveTimer.current);
      else sendCamera();
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        if (!sameCamera(lastSent.current, cameraRef.current)) sendCamera();
      }, 500);
    },
    [onZoomChange],
  );

  const stopAnimation = () => {
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
  };

  /** Gesto do usuário: para qualquer animação e, se era do núcleo, avisa que foi interrompida. */
  const userTakesOver = () => {
    stopAnimation();
    if (coreMotion.current) {
      void run("navigation.cancel", { navigationId: coreMotion.current, camera: cameraRef.current });
      lastSent.current = cameraRef.current;
      coreMotion.current = null;
    }
  };

  const animateTo = useCallback(
    (target: Camera, options: { persist: boolean; duration?: number; onDone?: () => void }) => {
      stopAnimation();
      const from = cameraRef.current;
      const started = performance.now();
      const duration = options.duration ?? 420;
      const step = (now: number) => {
        const t = Math.min((now - started) / duration, 1);
        const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        // Interpola o zoom em escala logarítmica para o movimento parecer uniforme.
        const zoom = Math.exp(Math.log(from.zoom) + (Math.log(target.zoom) - Math.log(from.zoom)) * k);
        const center = { x: from.center.x + (target.center.x - from.center.x) * k, y: from.center.y + (target.center.y - from.center.y) * k };
        setCamera(t === 1 ? target : { center, zoom }, options.persist && t === 1);
        if (t < 1) animation.current = requestAnimationFrame(step);
        else {
          animation.current = null;
          options.onDone?.();
        }
      };
      animation.current = requestAnimationFrame(step);
    },
    [setCamera],
  );

  // A câmera do núcleo mudou sem ter sido este canvas: é um movimento do agente (ou de uma sugestão).
  const storeCamera = snapshot.navigation.camera;
  const motion = snapshot.navigation.motion;
  useEffect(() => {
    if (sameCamera(storeCamera, lastSent.current) || sameCamera(storeCamera, cameraRef.current)) return;
    lastSent.current = storeCamera;
    const navigationId = motion.status === "animating" ? (motion.navigationId ?? null) : null;
    coreMotion.current = navigationId;
    animateTo(storeCamera, { persist: false, duration: 650, onDone: () => (coreMotion.current = null) });
    const ids = snapshot.navigation.focus.highlightIds ?? [];
    setHighlight(ids);
    if (!ids.length) return undefined;
    const timer = setTimeout(() => setHighlight([]), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeCamera.center.x, storeCamera.center.y, storeCamera.zoom]);

  const objects = snapshot.canvas.objects.map((o) => {
    const override = overrides[o.id];
    return override && override.revision >= (o.revision ?? 0) ? { ...o, ...override.rect } : o;
  });

  useImperativeHandle(
    handle,
    () => ({
      frame(ids = [], intent = "focus") {
        userTakesOver();
        const pool = ids.length ? objects.filter((o) => ids.includes(o.id)) : objects;
        const rects = pool.map((o) => ({ position: o.position, size: o.collapsed ? { width: o.size.width, height: 40 } : o.size }));
        if (!ids.length) rects.push(...snapshot.canvas.regions.map((r) => r.bounds), ...contextGroups(snapshot).map((g) => g.bounds));
        const target = computeFrame(rects, viewport, { intent, padding: 64 });
        if (target) animateTo(target, { persist: true });
      },
      zoomBy(factor) {
        userTakesOver();
        setCamera(zoomAt(cameraRef.current, viewport, { x: viewport.width / 2, y: viewport.height / 2 }, factor));
      },
      viewportCenter: () => cameraRef.current.center,
    }),
    [objects, viewport, animateTo, setCamera, snapshot],
  );

  useLayoutEffect(() => {
    const el = viewportRef.current!;
    const update = () => {
      const next = { width: el.clientWidth, height: el.clientHeight };
      setViewport(next);
      api().setViewport(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Esc interrompe um movimento automático.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && coreMotion.current) userTakesOver();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Roda: Ctrl/⌘ + roda (ou pinça no trackpad) faz zoom; roda sozinha desloca. Dentro de um mod, rola o mod.
  useEffect(() => {
    const el = viewportRef.current!;
    const onWheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest(".mod-body")) return;
      event.preventDefault();
      userTakesOver();
      const rect = el.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (event.ctrlKey || event.metaKey) setCamera(zoomAt(cameraRef.current, viewport, point, Math.exp(-event.deltaY * 0.01)));
      else setCamera(pan(cameraRef.current, -event.deltaX, -event.deltaY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [viewport, setCamera]);

  const startGesture = (event: React.PointerEvent, next: Gesture) => {
    userTakesOver();
    event.preventDefault();
    event.stopPropagation();
    viewportRef.current!.setPointerCapture(event.pointerId);
    gesture.current = next;
  };

  const onBackgroundPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0 && event.button !== 1) return;
    if ((event.target as HTMLElement).closest(".mod")) return;
    startGesture(event, { kind: "pan", last: { x: event.clientX, y: event.clientY } });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pan") {
      setCamera(pan(cameraRef.current, event.clientX - g.last.x, event.clientY - g.last.y));
      g.last = { x: event.clientX, y: event.clientY };
      return;
    }
    const zoom = cameraRef.current.zoom;
    const dx = (event.clientX - g.start.x) / zoom;
    const dy = (event.clientY - g.start.y) / zoom;
    const rect: Rect =
      g.kind === "move"
        ? { position: { x: Math.round(g.origin.position.x + dx), y: Math.round(g.origin.position.y + dy) }, size: g.origin.size }
        : {
            position: g.origin.position,
            size: {
              width: Math.round(Math.max(MIN_SIZE.width, g.origin.size.width + dx)),
              height: Math.round(Math.max(MIN_SIZE.height, g.origin.size.height + dy)),
            },
          };
    g.rect = rect;
    const current = snapshot.canvas.objects.find((o) => o.id === g.id);
    setOverrides((o) => ({ ...o, [g.id]: { rect, revision: (current?.revision ?? 0) + 1 } }));
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (viewportRef.current!.hasPointerCapture(event.pointerId)) viewportRef.current!.releasePointerCapture(event.pointerId);
    if (!g || g.kind === "pan" || !g.rect) return;
    void run("canvas.place", { objectId: g.id, position: g.rect.position, size: g.rect.size });
  };

  const objectGesture = (object: CanvasObject, kind: "move" | "resize") => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const current = objects.find((o) => o.id === object.id) ?? object;
    startGesture(event, { kind, id: object.id, start: { x: event.clientX, y: event.clientY }, origin: { position: current.position, size: current.size } });
  };

  const { center, zoom } = camera;
  const tx = viewport.width / 2 - center.x * zoom;
  const ty = viewport.height / 2 - center.y * zoom;
  const grid = 24 * zoom;
  const lit = new Set(highlight);
  // Grupos das unidades de contexto (doc 09): saem das âncoras, não são gravados. Uma unidade que já tem
  // região própria não ganha um segundo desenho.
  const withRegion = new Set(snapshot.canvas.regions.flatMap((r) => r.semanticEntityIds ?? []));
  const groups = contextGroups(snapshot).filter((g) => !withRegion.has(g.unitId));
  const activeRepo = snapshot.workspace.activeProjectId;

  return (
    <div
      ref={viewportRef}
      className="canvas"
      data-testid="canvas"
      style={{ backgroundSize: `${grid}px ${grid}px`, backgroundPosition: `${tx}px ${ty}px` }}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="world" style={{ transform: `translate(${tx}px, ${ty}px) scale(${zoom})` }}>
        {groups.map((g) => {
          const repo = g.kind === "repository";
          const active = repo && snapshot.semantic.entities.find((e) => e.id === g.unitId)?.projectId === activeRepo;
          return (
            <div
              key={g.unitId}
              className={`unit-group${repo ? " is-repository" : ""}${active ? " is-active" : ""}${lit.has(g.unitId) ? " is-highlighted" : ""}`}
              data-testid="unit-group"
              data-unit-id={g.unitId}
              style={{ left: g.bounds.position.x, top: g.bounds.position.y, width: g.bounds.size.width, height: g.bounds.size.height }}
            >
              <span className="unit-title">{g.name}</span>
            </div>
          );
        })}
        {snapshot.canvas.regions.map((region) => (
          <div
            key={region.id}
            className={`region${lit.has(region.id) ? " is-highlighted" : ""}`}
            data-region-id={region.id}
            style={{
              left: region.bounds.position.x,
              top: region.bounds.position.y,
              width: region.bounds.size.width,
              height: region.bounds.size.height,
            }}
          >
            <span className="region-title">{region.title}</span>
          </div>
        ))}
        {objects
          .slice()
          .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
          .map((object) => (
            <div
              key={object.id}
              className="mod-slot"
              style={{
                left: object.position.x,
                top: object.position.y,
                width: object.size.width,
                height: object.collapsed ? undefined : object.size.height,
                zIndex: (object.zIndex ?? 0) + 1,
              }}
            >
              {renderObject({
                object,
                zoom,
                highlighted: lit.has(object.id),
                highlightIds: lit,
                onHeaderPointerDown: objectGesture(object, "move"),
                onResizePointerDown: objectGesture(object, "resize"),
              })}
            </div>
          ))}
      </div>
    </div>
  );
}
