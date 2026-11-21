// Wraps a control with its name, shortcut and (in explain mode) a plain-language
// explanation from the action registry.
import * as Tooltip from "@radix-ui/react-tooltip";
import clsx from "clsx";
import type { ReactNode } from "react";
import { findAction, shortcutLabel } from "../../lib/actions";
import { useApp } from "../../store/app";

export function Ctl({ id, label, explain, children, side = "top", className }: { id?: string; label?: string; explain?: string; children: ReactNode; side?: "top" | "bottom" | "left" | "right"; className?: string }) {
  const explainOn = useApp((s) => s.explain || s.explainHeld);
  useApp((s) => s.registry);
  const spec = id ? findAction(id) : undefined;
  const name = label ?? spec?.label;
  const text = explain ?? spec?.explain;
  const key = shortcutLabel(spec?.shortcut);
  if (!name && !text) return <>{children}</>;
  return (
    <Tooltip.Root delayDuration={explainOn ? 0 : 650}>
      <Tooltip.Trigger asChild>
        <span className={clsx("inline-flex", explainOn && text && "explain-ring", className)} data-action={id}>
          {children}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side={side} sideOffset={6} className={clsx("z-50 rounded-lg border border-white/10 bg-zinc-900/95 px-3 py-2 text-xs text-zinc-200 shadow-xl backdrop-blur", explainOn ? "max-w-72" : "max-w-56")}>
          <div className="flex items-center gap-2 font-medium text-zinc-50">
            <span>{name}</span>
            {key && <kbd className="rounded border border-white/15 bg-white/5 px-1.5 py-px font-mono text-[10px] text-zinc-300">{key}</kbd>}
          </div>
          {explainOn && text && <p className="mt-1 leading-snug text-zinc-300">{text}</p>}
          <Tooltip.Arrow className="fill-zinc-900" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
