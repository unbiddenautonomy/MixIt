// The button that moves a part of the screen (the library, the tools panel) to another
// screen. Click it for a menu ("Move to screen 2", "Back to the main window"), or drag
// it out of the window and let go over another screen. Only the desktop app has it.
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MonitorUp } from "lucide-react";
import { useRef, useState, type PointerEvent } from "react";
import { movePart, movePartToPointer, PART_NAMES, screenLabel, targetsFor, thisPart, useScreens, type Part } from "../../lib/screens";

export function MoveToScreen({ part }: { part: Part }) {
  const supported = useScreens((s) => s.supported) || thisPart !== null;
  const screens = useScreens((s) => s.screens);
  const placement = useScreens((s) => s.placement);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  if (!supported) return null;
  const targets = targetsFor(part, { supported, screens, main: useScreens.getState().main, placement });
  const away = thisPart === part;

  // Dragging the button out of the window moves the part to the screen it is let go on.
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    start.current = { x: e.clientX, y: e.clientY, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    const s = start.current;
    if (!s) return;
    if (!s.moved && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 8) {
      s.moved = true;
      setDragging(true);
    }
  };
  const up = (e: PointerEvent) => {
    const s = start.current;
    start.current = null;
    setDragging(false);
    if (!s?.moved) return;
    e.preventDefault();
    const outside = e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;
    if (outside) void movePartToPointer(part);
  };

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={`Move the ${PART_NAMES[part].toLowerCase()} to another screen`}
            title="Move to another screen: pick one, or drag this button onto it"
            data-testid={`move-${part}`}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onClickCapture={(e) => {
              // The end of a drag is not a click.
              if (dragging) e.preventDefault();
            }}
            className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 active:cursor-grabbing"
          >
            <MonitorUp size={13} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className="menu">
            <DropdownMenu.Label className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{PART_NAMES[part]}</DropdownMenu.Label>
            {targets.map((s) => (
              <DropdownMenu.Item key={s.name} className="menu-item" onSelect={() => void movePart(part, s)}>
                Move to {screenLabel(screens, s)}
              </DropdownMenu.Item>
            ))}
            {(away || placement[part]) && (
              <DropdownMenu.Item className="menu-item" onSelect={() => void movePart(part, null)}>
                Back to the main window
              </DropdownMenu.Item>
            )}
            {targets.length === 0 && !away && <div className="max-w-[16rem] px-2 py-1.5 text-[11px] leading-snug text-zinc-400">Connect another screen to move this there. MixIt remembers where you put things for each set of screens.</div>}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {dragging && (
        <div className="pointer-events-none fixed inset-x-0 top-14 z-[70] mx-auto w-fit rounded-lg border border-white/10 bg-zinc-900/95 px-3 py-2 text-xs text-zinc-200 shadow-2xl">
          Let go over another screen to open the {PART_NAMES[part].toLowerCase()} there
        </div>
      )}
    </>
  );
}
