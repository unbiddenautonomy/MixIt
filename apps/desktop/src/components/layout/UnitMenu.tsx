// The ⋯ menu on every part of the new layout: send it to another window, open it in a new
// window on a screen, bring it back to Window 1, or swap the screens the windows are on.
// The browser version has one window, so there the menu isn't shown.
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { MAIN, MAX_WINDOWS, orderedScreens, placesOf, refOf, resolveScreen, sameScreen, type Env, type UnitId } from "../../lib/layout/model";
import { UNITS } from "../../lib/layout/units";
import { screenName, windowLabel } from "../../lib/layout/windows";
import { layoutDoUndoable, mainScreenRef, useLayout } from "../../store/layout";

export function UnitMenu({ unit, win, env }: { unit: UnitId; win: string; env: Env }) {
  const layout = useLayout((s) => s.layout);
  if (!layout || env.browser || !env.screens.length) return null;
  const name = UNITS[unit].name;
  const screens = orderedScreens(env.screens);
  const others = layout.windows.filter((w) => w.id !== win);
  const mainAt = layout.windows[0].screen ?? mainScreenRef(env);
  const perf = mainAt ? resolveScreen(env.screens, mainAt) : null;
  const canOpen = layout.windows.length < MAX_WINDOWS;
  const away = !placesOf(layout, unit).some((f) => f.win.id === MAIN);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label={`More for ${name}: send it to another window or screen`} title={`Send ${name} to another window or screen`} data-unit-menu={unit} className="flex size-6 items-center justify-center rounded text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100">
          <MoreHorizontal size={13} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className="menu">
          <DropdownMenu.Label className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{name}</DropdownMenu.Label>
          {others.map((w) => (
            <DropdownMenu.Item key={w.id} className="menu-item" onSelect={() => layoutDoUndoable(w.id === MAIN && away ? { op: "home", unit } : { op: "send", unit, win: w.id }, `${name} moved to ${windowLabel(layout, w.id, env.screens)}.`)}>
              Send to {windowLabel(layout, w.id, env.screens)}
            </DropdownMenu.Item>
          ))}
          {screens.map((s) => (
            <DropdownMenu.Item key={`new-${s.name}-${s.x}-${s.y}`} className="menu-item" disabled={!canOpen} onSelect={() => layoutDoUndoable({ op: "newWindow", unit, screen: refOf(env.screens, s) }, `${name} opened in a new window on ${screenName(env.screens, s)}.`)}>
              New window on {screenName(env.screens, s)}
            </DropdownMenu.Item>
          ))}
          {!canOpen && <div className="max-w-[16rem] px-2 py-1.5 text-[11px] leading-snug text-zinc-400">MixIt can have up to {MAX_WINDOWS} windows. Send this to one that's open, or close one first.</div>}
          {perf && screens.length > 1 && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-white/[0.06]" />
              <div className="max-w-[16rem] px-2 pb-1 text-[11px] leading-snug text-zinc-500">Swapping moves every window on one screen to the other.</div>
              {screens
                .filter((s) => s !== perf)
                .map((s) => (
                  <DropdownMenu.Item
                    key={`swap-${s.name}-${s.x}-${s.y}`}
                    className="menu-item"
                    onSelect={() => mainAt && !sameScreen(mainAt, refOf(env.screens, s)) && layoutDoUndoable({ op: "swap", a: mainAt, b: refOf(env.screens, s), mainAt }, `Swapped Screen ${screens.indexOf(perf) + 1} and Screen ${screens.indexOf(s) + 1}.`)}
                  >
                    Swap Screen {screens.indexOf(perf) + 1} and Screen {screens.indexOf(s) + 1}
                  </DropdownMenu.Item>
                ))}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
