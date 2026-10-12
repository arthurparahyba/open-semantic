import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";

import { computeFrame, pan, zoomAt, type FrameOptions, type Viewport } from "@open-semantic/navigator";
import type { Camera, CanvasObject, ModInstance, Point, Rect, WorkspaceSnapshot } from "@open-semantic/protocol";

import { run } from "./client.js";

export interface CanvasHandle {
  /** Enquadra os objetos (todos, se ids vazio) com animação. */
  frame(ids?: string[], intent?: FrameOptions["intent"]): void;
  zoomBy(factor: number): void;
  viewportCenter(): Point;
}

export interface ModRenderProps {
  mod: ModInstance;
  object: CanvasObject;
  onHeaderPointerDown(event: React.PointerEvent): void;
  onResizePointerDown(event: React.PointerEvent): void;
}

interface Props {
  snapshot: WorkspaceSnapshot;
  handle: Ref<CanvasHandle>;
  renderMod(props: ModRenderProps): ReactNode;
  onZoomChange?(zoom: number): void;
}

type Gesture =
  | { kind: "pan"; last: Point }
  | { kind: "move" | "resize"; id: string; start: Point; origin: Rect; rect?: Rect };

const MIN_SIZE = { width: 220, height: 120 };

/**
 * Canvas infinito: câmera (pan/zoom), objetos posicionados no mundo e gestos do usuário.
 * A geometria do enquadramento vem de @open-semantic/navigator.
 */
export function Canvas({ snapshot, handle, renderMod, onZoomChange }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ width: 1, height: 1 });
  const [camera, setCameraState] = useState<Camera>(snapshot.navigation.camera);
  const cameraRef = useRef(camera);
  const gesture = useRef<Gesture | null>(null);
  const animation = useRef<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Posições locais durante arrasto, até o núcleo confirmar a nova revisão.
  const [overrides, setOverrides] = useState<Record<string, { rect: Rect; revision: number }>>({});

  const setCamera = useCallback(
    (next: Camera, persist = true) => {
      cameraRef.current = next;
      setCameraState(next);
      onZoomChange?.(next.zoom);
      if (persist) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => void run("navigation.set_camera", { camera: cameraRef.current }), 600);
      }
    },
    [onZoomChange],
  );

  const cancelAnimation = () => {
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
  };

  const animateTo = useCallback(
    (target: Camera) => {
      cancelAnimation();
      const from = cameraRef.current;
      const started = performance.now();
      const duration = 380;
      const step = (now: number) => {
        const t = Math.min((now - started) / duration, 1);
        const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        // Interpola o zoom em escala logarítmica para o movimento parecer uniforme.
        const zoom = Math.exp(Math.log(from.zoom) + (Math.log(target.zoom) - Math.log(from.zoom)) * k);
        const center = { x: from.center.x + (target.center.x - from.center.x) * k, y: from.center.y + (target.center.y - from.center.y) * k };
        setCamera({ center, zoom }, t === 1);
        animation.current = t < 1 ? requestAnimationFrame(step) : null;
      };
      animation.current = requestAnimationFrame(step);
    },
    [setCamera],
  );

  const objects = snapshot.canvas.objects.map((o) => {
    const override = overrides[o.id];
    return override && override.revision >= (o.revision ?? 0) ? { ...o, ...override.rect } : o;
  });

  useImperativeHandle(
    handle,
    () => ({
      frame(ids = [], intent = "focus") {
        const pool = ids.length ? objects.filter((o) => ids.includes(o.id)) : objects;
        const rects = pool.map((o) => ({ position: o.position, size: o.collapsed ? { width: o.size.width, height: 40 } : o.size }));
        const target = computeFrame(rects, viewport, { intent, padding: 64 });
        if (target) animateTo(target);
      },
      zoomBy(factor) {
        cancelAnimation();
        setCamera(zoomAt(cameraRef.current, viewport, { x: viewport.width / 2, y: viewport.height / 2 }, factor));
      },
      viewportCenter: () => cameraRef.current.center,
    }),
    [objects, viewport, animateTo, setCamera],
  );

  useLayoutEffect(() => {
    const el = viewportRef.current!;
    const update = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Roda: Ctrl/⌘ + roda (ou pinça no trackpad) faz zoom; roda sozinha desloca. Dentro de um mod, rola o mod.
  useEffect(() => {
    const el = viewportRef.current!;
    const onWheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest(".mod-body")) return;
      event.preventDefault();
      cancelAnimation();
      const rect = el.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (event.ctrlKey || event.metaKey) setCamera(zoomAt(cameraRef.current, viewport, point, Math.exp(-event.deltaY * 0.01)));
      else setCamera(pan(cameraRef.current, -event.deltaX, -event.deltaY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [viewport, setCamera]);

  const startGesture = (event: React.PointerEvent, next: Gesture) => {
    cancelAnimation();
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
  const mods = new Map(snapshot.mods.map((m) => [m.id, m]));

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
        {objects
          .slice()
          .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
          .map((object) => {
            const mod = mods.get(object.id);
            if (!mod) return null;
            return (
              <div
                key={object.id}
                className="mod-slot"
                style={{
                  left: object.position.x,
                  top: object.position.y,
                  width: object.size.width,
                  height: object.collapsed ? undefined : object.size.height,
                  zIndex: object.zIndex ?? 0,
                }}
              >
                {renderMod({ mod, object, onHeaderPointerDown: objectGesture(object, "move"), onResizePointerDown: objectGesture(object, "resize") })}
              </div>
            );
          })}
      </div>
    </div>
  );
}
