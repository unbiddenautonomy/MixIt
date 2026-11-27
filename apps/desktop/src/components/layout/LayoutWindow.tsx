// Draws a window from the layout (Settings > Display > New layout): the main window, or
// one of the layout's windows on another screen (`?win=`), which draws the main window's
// layout and asks it for every change (store/layoutShare.ts).
//
// The tree draws empty slots; each unit is rendered once into a host element of its own
// through a portal, and the host element is moved into whichever slot shows it. Moving a
// unit to another slot so moves a DOM node and never remounts the unit, so its scroll
// position, canvas and any drag in progress survive. A unit that is folded, on a tab that
// isn't showing, or on another page isn't drawn at all, as tabs and pages work today.
import clsx from "clsx";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import { Component, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ErrorInfo, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { TAB_PX, hardMinFor, drawnAt, fitTree, isCollapsed, minSize, shownPlace, visiblePlaces, type Fit } from "../../lib/layout/fit";
import { MAIN, findWin, isFolded, type Env, type LayoutNode, type PageId, type Split, type Stack, type UnitId } from "../../lib/layout/model";
import { BAR_PX, HANDLE_PX, UNITS } from "../../lib/layout/units";
import { useApp } from "../../store/app";
import { ME, initLayout, layoutDo, layoutEnv, setLayoutSize, showLayoutPage, useLayout } from "../../store/layout";
import { dropOn, previewBox, sideAt, type Box } from "../../lib/layout/dock";
import { isRefusal, run, type Op } from "../../lib/layout/ops";
import { EditBar } from "./EditBar";
import { UnitMenu } from "./UnitMenu";
import { UnitView } from "./units";

interface Ctx {
  /** The window being drawn. */
  win: string;
  page: PageId;
  env: Env;
  fit: Fit;
  host: (unit: UnitId) => HTMLDivElement;
  /** Opens a unit that was folded only to fit: it then stays open, and others give way or the page scrolls. */
  keepOpen: (unit: UnitId, open: boolean) => void;
  /** Edit layout mode: tabs can be dragged. */
  editing: boolean;
  /** Starts dragging a unit by its tab (Edit layout mode). */
  startDrag: (unit: UnitId, e: ReactPointerEvent) => void;
}

/** A drag in progress: the unit, the pointer, and what letting go there would do. */
interface Drag {
  unit: UnitId;
  x: number;
  y: number;
  drop: { op: Op; box: Box; why: string | null } | null;
}
const LayoutCtx = createContext<Ctx | null>(null);
const useCtx = () => useContext(LayoutCtx)!;

const collapsed = (node: LayoutNode, ctx: Ctx) => isCollapsed(node, ctx.env, ctx.fit.autoFolded);
const drawn = (node: LayoutNode, env: Env) => drawnAt(node, env);

/** The units this page shows right now: each stack's tab, unless it is folded. */
function shownUnits(node: LayoutNode | undefined, ctx: Pick<Ctx, "env" | "fit">): UnitId[] {
  if (!node) return [];
  if (node.kind === "split") return node.children.flatMap((c) => shownUnits(c, ctx));
  const p = shownPlace(node, ctx.env);
  if (!p || isFolded(p, ctx.env.controller) || ctx.fit.autoFolded.has(p.unit)) return [];
  return [p.unit];
}

export function LayoutWindow() {
  const win = ME;
  const layout = useLayout((s) => s.layout);
  const size = useLayout((s) => s.size);
  const workspace = useApp((s) => s.workspace) as PageId;
  // The main window's page follows the top bar; another window's is in the layout.
  const ownPage = useLayout((s) => (s.layout ? findWin(s.layout, win)?.page : undefined));
  const page = win === MAIN ? workspace : (ownPage ?? "mix");
  // The settings these depend on, as primitives so the memo below holds.
  const decks = useApp((s) => s.settings?.decks ?? 2);
  const mode = useApp((s) => s.settings?.viewMode ?? "easy");
  const controller = useApp((s) => !!s.settings?.controllerConnected);
  const area = useRef<HTMLDivElement>(null);
  const hosts = useRef(new Map<UnitId, HTMLDivElement>());
  // Not saved: a unit the person opened while the window was too small for it.
  const [kept, setKept] = useState<ReadonlySet<UnitId>>(new Set());
  const editing = useLayout((s) => s.editing);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragging = useRef(false);
  const isDragging = useCallback(() => dragging.current, []);

  /** What letting go of `unit` at (x, y) would do, and why not if it can't. */
  const dropAt = useCallback(
    (unit: UnitId, x: number, y: number): Drag["drop"] => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]");
      if (!el || !area.current?.contains(el)) return null;
      const r = el.getBoundingClientRect();
      const b: Box = { left: r.left, top: r.top, width: r.width, height: r.height };
      let op: Op;
      let box = b;
      if (el.dataset.drop === "page") op = { op: "send", unit, win, page };
      else {
        const units = (el.dataset.units ?? "").split(",").filter(Boolean) as UnitId[];
        const d = dropOn(unit, sideAt(x, y, b), units, el.dataset.drop as UnitId);
        if (!d) return null;
        op = { op: "place", unit, target: { win, page, unit: d.unit }, side: d.side };
        box = previewBox(d.side, b);
      }
      // Tried on a copy first, so the person sees before letting go whether it will work.
      const l = useLayout.getState().layout;
      const res = l ? run(l, layoutEnv(), op) : null;
      return { op, box, why: isRefusal(res) ? res.reason : null };
    },
    [win, page],
  );

  const startDrag = useCallback(
    (unit: UnitId, e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      const target = e.currentTarget as HTMLElement;
      const sx = e.clientX;
      const sy = e.clientY;
      let started = false;
      let latest: Drag["drop"] = null;
      const move = (ev: PointerEvent) => {
        if (!started) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
          started = true;
          dragging.current = true;
          try {
            target.setPointerCapture(ev.pointerId);
          } catch {
            /* the drag still follows the window's events */
          }
        }
        latest = dropAt(unit, ev.clientX, ev.clientY);
        setDrag({ unit, x: ev.clientX, y: ev.clientY, drop: latest });
      };
      const end = (commit: boolean) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", key, true);
        if (!started) return;
        dragging.current = false;
        setDrag(null);
        // The end of a drag isn't a click on the tab.
        const eat = (c: MouseEvent) => {
          c.stopPropagation();
          c.preventDefault();
        };
        window.addEventListener("click", eat, { capture: true, once: true });
        window.setTimeout(() => window.removeEventListener("click", eat, true), 0);
        if (commit && latest && !latest.why) layoutDo(latest.op);
      };
      const up = () => end(true);
      const cancel = () => end(false);
      const key = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape" || !started) return;
        ev.stopPropagation();
        ev.preventDefault();
        end(false);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", key, true);
    },
    [dropAt],
  );

  useEffect(() => void initLayout(), []);
  useEffect(() => {
    if (win === MAIN) showLayoutPage(page);
  }, [win, page]);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setLayoutSize(el.clientWidth, el.clientHeight));
    ro.observe(el);
    setLayoutSize(el.clientWidth, el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // layoutEnv reads these same values from the stores; they are listed so the memo follows them.
  const env = useMemo(() => layoutEnv(), [decks, mode, controller, size.w, size.h]);
  const root = layout ? findWin(layout, win)?.pages[page] : undefined;
  const fit = useMemo(() => fitTree(root, size, env, hardMinFor(win), kept), [root, size, env, kept, win]);
  const need = useMemo(() => (root ? minSize(root, env, fit.autoFolded) : { w: 0, h: 0 }), [root, env, fit]);
  const ctx: Ctx = useMemo(
    () => ({
      win,
      page,
      env,
      fit,
      host: (unit) => {
        let el = hosts.current.get(unit);
        if (!el) {
          el = document.createElement("div");
          el.className = "flex h-full min-h-0 w-full min-w-0 flex-col";
          el.dataset.unit = unit;
          hosts.current.set(unit, el);
        }
        return el;
      },
      keepOpen: (unit, open) =>
        setKept((k) => {
          if (k.has(unit) === open) return k;
          const next = new Set(k);
          if (open) next.add(unit);
          else next.delete(unit);
          return next;
        }),
      editing,
      startDrag,
    }),
    [win, page, env, fit, editing, startDrag],
  );
  const shown = useMemo(() => shownUnits(root, { env, fit }), [root, env, fit]);

  return (
    <LayoutCtx.Provider value={ctx}>
      <EditBar dragging={isDragging} />
      <div ref={area} data-testid="layout" className={clsx("relative min-h-0 min-w-0 flex-1", fit.scroll ? "overflow-auto" : "overflow-hidden")}>
        <div className="flex h-full w-full" style={fit.scroll ? { minWidth: need.w, minHeight: need.h } : undefined}>
          {root ? <NodeView node={root} path={[]} parentDir={null} /> : layout ? <EmptyPage page={page} /> : null}
        </div>
      </div>
      {drag && <DragPreview drag={drag} />}
      {shown.map((unit) =>
        createPortal(
          <UnitBoundary unit={unit}>
            <UnitView unit={unit} />
          </UnitBoundary>,
          ctx.host(unit),
          unit,
        ),
      )}
    </LayoutCtx.Provider>
  );
}

function EmptyPage({ page }: { page: PageId }) {
  return (
    <div data-drop="page" className="flex flex-1 items-center justify-center text-sm text-zinc-500">
      Nothing is on the {page === "mix" ? "Mix" : page === "library" ? "Library" : "Arrange"} page.
    </div>
  );
}

/** Where the dragged part will go (or why it can't), and its name by the pointer. */
function DragPreview({ drag }: { drag: Drag }) {
  const d = drag.drop;
  const name = UNITS[drag.unit].name;
  return (
    <div className="pointer-events-none fixed inset-0 z-50" aria-live="polite">
      {d && <div className={clsx("absolute rounded-lg border-2", d.why ? "border-red-400/70 bg-red-500/10" : "border-[var(--accent)] bg-[var(--accent)]/15")} style={{ left: d.box.left, top: d.box.top, width: d.box.width, height: d.box.height }} />}
      <div className="absolute max-w-xs rounded-md border border-white/10 bg-zinc-900/95 px-2 py-1 text-[11px] text-zinc-200 shadow-lg" style={{ left: drag.x + 14, top: drag.y + 14 }}>
        {d?.why ?? (d ? `Move ${name} here` : `Move ${name}: point at another part`)}
      </div>
    </div>
  );
}

function NodeView({ node, path, parentDir }: { node: LayoutNode; path: number[]; parentDir: "row" | "col" | null }) {
  const ctx = useCtx();
  // A whole area folded (say the library row) is one bar across, not a row of slivers.
  if (node.kind === "split" && collapsed(node, ctx)) return <GroupBar node={node} vertical={parentDir === "row"} />;
  return node.kind === "split" ? <SplitView node={node} path={path} /> : <StackView node={node} parentDir={parentDir} />;
}

/** The units a folded area holds, as one bar; opening it opens them all. */
function GroupBar({ node, vertical }: { node: Split; vertical: boolean }) {
  const ctx = useCtx();
  const shown = stacksOfNode(node)
    .map((st) => shownPlace(st, ctx.env))
    .filter((p): p is NonNullable<typeof p> => !!p);
  const names = shown.map((p) => UNITS[p.unit].name).join(", ");
  const auto = shown.some((p) => ctx.fit.autoFolded.has(p.unit));
  const Icon = vertical ? ChevronRight : ChevronDown;
  const open = () => {
    for (const p of shown) {
      ctx.keepOpen(p.unit, true);
      if (isFolded(p, ctx.env.controller)) layoutDo({ op: "fold", unit: p.unit, folded: false, where: { win: ctx.win, page: ctx.page } });
    }
  };
  return (
    <button
      type="button"
      data-folded={shown.map((p) => p.unit).join(" ")}
      data-auto={auto || undefined}
      title={`Open ${names}`}
      aria-label={`Open ${names}`}
      aria-expanded={false}
      onClick={open}
      className={clsx(
        "flex min-h-0 min-w-0 flex-1 shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.06] bg-zinc-900/60 text-[11px] font-medium text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100",
        vertical ? "h-full flex-col justify-start py-2" : "w-full flex-row px-2",
        auto && "border-dashed",
      )}
      style={vertical ? { width: BAR_PX, flex: "none" } : { height: BAR_PX, flex: "none" }}
    >
      <Icon size={13} className="shrink-0" />
      <span className={clsx("truncate", vertical && "[writing-mode:vertical-rl]")}>{names}</span>
    </button>
  );
}

function stacksOfNode(node: LayoutNode): Stack[] {
  return node.kind === "stack" ? [node] : node.children.flatMap(stacksOfNode);
}

function SplitView({ node, path }: { node: Split; path: number[] }) {
  const ctx = useCtx();
  const box = useRef<HTMLDivElement>(null);
  // Shares while a handle is being dragged; committed once, on release.
  const [live, setLive] = useState<number[] | null>(null);
  const sizes = live ?? node.sizes;
  const row = node.dir === "row";
  const kids = node.children.map((c, i) => ({ c, i })).filter(({ c }) => drawn(c, ctx.env));

  const startDrag = (e: ReactPointerEvent, a: number, b: number) => {
    const el = box.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const length = (row ? el.clientWidth : el.clientHeight) - (kids.length - 1) * HANDLE_PX;
    const start = row ? e.clientX : e.clientY;
    const base = [...node.sizes];
    // The layout this drag is about; if it is replaced mid-drag (screens changed), the drag is dropped.
    const at = useLayout.getState().layout;
    const pair = base[a] + base[b];
    let latest = base;
    const move = (ev: PointerEvent) => {
      const d = ((row ? ev.clientX : ev.clientY) - start) / Math.max(1, length);
      const na = Math.max(0.02, Math.min(pair - 0.02, base[a] + d));
      latest = base.map((s, i) => (i === a ? na : i === b ? pair - na : s));
      setLive(latest);
    };
    const end = (commit: boolean) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", cancel);
      target.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("keydown", key, true);
      setLive(null);
      // The operation holds each side to its smallest size.
      if (commit && latest !== base && useLayout.getState().layout === at) layoutDo({ op: "resize", win: ctx.win, page: ctx.page, path, sizes: latest });
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        end(false);
      }
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", cancel);
    target.addEventListener("lostpointercapture", cancel);
    window.addEventListener("keydown", key, true);
  };

  // Shares among the children that take a share: a hidden one (deck C with two decks) or a
  // folded one gives its space to the rest. Flex leaves space empty when the shares add up to less than 1.
  const total = kids.reduce((a, { c, i }) => (collapsed(c, ctx) ? a : a + sizes[i]), 0) || 1;
  const out: ReactNode[] = [];
  kids.forEach(({ c, i }, k) => {
    if (k > 0) {
      const prev = kids[k - 1].i;
      const fixed = collapsed(c, ctx) || collapsed(node.children[prev], ctx);
      out.push(
        <div
          key={`h${i}`}
          role="separator"
          aria-orientation={row ? "vertical" : "horizontal"}
          aria-label="Drag to share the space"
          onPointerDown={fixed ? undefined : (e) => startDrag(e, prev, i)}
          className={clsx("group flex shrink-0 items-center justify-center", row ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize", fixed && "cursor-default")}
          style={row ? { width: HANDLE_PX } : { height: HANDLE_PX }}
        >
          {!fixed && <div className={clsx("rounded-full bg-white/0 group-hover:bg-white/25", row ? "h-10 w-0.5" : "h-0.5 w-10")} />}
        </div>,
      );
    }
    const m = minSize(c, ctx.env, ctx.fit.autoFolded);
    const shut = collapsed(c, ctx);
    out.push(
      <div
        key={`c${i}`}
        className="flex min-h-0 min-w-0"
        style={{
          flex: shut ? "0 0 auto" : `${sizes[i] / total} 1 0px`,
          [row ? "minWidth" : "minHeight"]: shut ? BAR_PX : row ? m.w : m.h,
        }}
      >
        <NodeView node={c} path={[...path, i]} parentDir={node.dir} />
      </div>,
    );
  });
  return (
    <div ref={box} className={clsx("flex min-h-0 min-w-0 flex-1", row ? "flex-row" : "flex-col")}>
      {out}
    </div>
  );
}

function StackView({ node, parentDir }: { node: Stack; parentDir: "row" | "col" | null }) {
  const ctx = useCtx();
  const places = visiblePlaces(node, ctx.env);
  const shown = shownPlace(node, ctx.env);
  if (!shown) return null;
  const person = isFolded(shown, ctx.env.controller);
  const auto = !person && ctx.fit.autoFolded.has(shown.unit);
  const where = { win: ctx.win, page: ctx.page };
  const fold = (folded: boolean) => {
    ctx.keepOpen(shown.unit, !folded);
    layoutDo({ op: "fold", unit: shown.unit, folded, where });
  };

  const units = node.units.map((p) => p.unit).join(",");
  if (person || auto) return <FoldedBar unit={shown.unit} units={units} vertical={parentDir === "row"} auto={auto} onOpen={() => fold(false)} />;

  const FoldIcon = parentDir === "row" ? ChevronLeft : ChevronUp;
  return (
    <section className={clsx("flex min-h-0 min-w-0 flex-1 flex-col", ctx.editing && "rounded-lg outline outline-1 -outline-offset-1 outline-[var(--accent)]/25")} data-stack={shown.unit} data-drop={shown.unit} data-units={units} aria-label={UNITS[shown.unit].name}>
      <div role="tablist" className="flex shrink-0 items-center gap-0.5 px-1 text-[11px]" style={{ height: TAB_PX }}>
        {places.map((p) => {
          const active = p === shown;
          return (
            <button
              key={p.unit}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => layoutDo({ op: "activate", unit: p.unit, where })}
              onPointerDown={ctx.editing ? (e) => ctx.startDrag(p.unit, e) : undefined}
              title={ctx.editing ? `Drag ${UNITS[p.unit].name} to move it` : undefined}
              className={clsx("h-5 truncate rounded px-1.5 font-medium", active ? "text-zinc-200" : "text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200", ctx.editing ? "cursor-grab touch-none bg-white/[0.04] active:cursor-grabbing" : places.length === 1 && "pointer-events-none")}
            >
              {UNITS[p.unit].name}
            </button>
          );
        })}
        <span className="ml-auto" />
        <UnitMenu unit={shown.unit} win={ctx.win} env={ctx.env} />
        <button type="button" title={`Fold ${UNITS[shown.unit].name}`} aria-label={`Fold ${UNITS[shown.unit].name}`} onClick={() => fold(true)} className="flex size-5 items-center justify-center rounded text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100">
          <FoldIcon size={13} />
        </button>
      </div>
      <Slot unit={shown.unit} />
    </section>
  );
}

/** A folded unit: a slim bar with its name and an arrow to open it. */
function FoldedBar({ unit, units, vertical, auto, onOpen }: { unit: UnitId; units: string; vertical: boolean; auto: boolean; onOpen: () => void }) {
  const name = UNITS[unit].name;
  const Icon = vertical ? ChevronRight : ChevronDown;
  const hint = auto ? `Open ${name} (folded to fit the window; opening it makes room by folding something else, or lets the page scroll)` : `Open ${name}`;
  return (
    <button
      type="button"
      data-folded={unit}
      data-drop={unit}
      data-units={units}
      data-auto={auto || undefined}
      title={hint}
      aria-label={`Open ${name}`}
      aria-expanded={false}
      onClick={onOpen}
      className={clsx(
        "flex shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.06] bg-zinc-900/60 text-[11px] font-medium text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100",
        vertical ? "h-full flex-col justify-start py-2" : "w-full flex-row px-2",
        auto && "border-dashed",
      )}
      style={vertical ? { width: BAR_PX } : { height: BAR_PX }}
    >
      <Icon size={13} className="shrink-0" />
      <span className={clsx("truncate", vertical && "[writing-mode:vertical-rl]")}>{name}</span>
    </button>
  );
}

/** Where a unit's host element is put while this slot shows it. */
function Slot({ unit }: { unit: UnitId }) {
  const { host } = useCtx();
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = el.current;
    const h = host(unit);
    if (!slot) return;
    slot.appendChild(h);
    return () => {
      if (h.parentNode === slot) slot.removeChild(h);
    };
  }, [unit, host]);
  return <div ref={el} className="flex min-h-0 min-w-0 flex-1 overflow-auto" data-slot={unit} />;
}

/** One unit that throws shows a note and a way back; the rest of the window, and the music, carry on. */
class UnitBoundary extends Component<{ unit: UnitId; children: ReactNode }, { error: Error | null; round: number }> {
  state = { error: null as Error | null, round: 0 };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[layout] ${this.props.unit} failed`, error, info.componentStack);
  }
  render() {
    if (!this.state.error) return <UnitKey round={this.state.round}>{this.props.children}</UnitKey>;
    return (
      <div role="alert" className="m-auto flex flex-col items-center gap-2 p-4 text-center text-xs text-zinc-400">
        <div>{UNITS[this.props.unit].name} hit a problem. The music carries on.</div>
        <button type="button" className="rounded-md border border-white/10 px-2 py-1 text-zinc-200 hover:bg-white/[0.06]" onClick={() => this.setState((s) => ({ error: null, round: s.round + 1 }))}>
          Reload part
        </button>
      </div>
    );
  }
}

/** Remounts its children when `round` changes, so "Reload part" starts the unit afresh. */
function UnitKey({ round, children }: { round: number; children: ReactNode }) {
  return <div key={round} className="contents">{children}</div>;
}
