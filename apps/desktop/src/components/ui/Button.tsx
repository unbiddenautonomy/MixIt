import clsx from "clsx";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { press, release } from "../../lib/actions";

type Tone = "default" | "accent" | "play" | "cue" | "danger" | "ghost";

const tones: Record<Tone, string> = {
  default: "bg-white/[0.06] hover:bg-white/[0.10] text-zinc-200 border-white/10",
  accent: "bg-[var(--accent)]/15 hover:bg-[var(--accent)]/25 text-[var(--accent-ink)] border-[var(--accent)]/40",
  play: "bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border-emerald-400/30",
  cue: "bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border-amber-400/30",
  danger: "bg-red-500/10 hover:bg-red-500/20 text-red-300 border-red-400/30",
  ghost: "bg-transparent hover:bg-white/[0.06] text-zinc-300 border-transparent",
};

export function Btn({ tone = "default", active, className, children, size = "md", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; active?: boolean; size?: "sm" | "md" | "lg"; children: ReactNode }) {
  return (
    <button
      type="button"
      {...rest}
      className={clsx(
        "inline-flex select-none items-center justify-center gap-1.5 rounded-lg border font-medium transition-colors duration-75 disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "h-7 px-2 text-xs" : size === "lg" ? "h-12 px-4 text-sm" : "h-8 px-3 text-xs",
        tones[tone],
        active && "!bg-[var(--accent)] !text-zinc-950 !border-transparent shadow-[0_0_16px_-2px_var(--accent)]",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** A button bound to an action: press on pointer down, release on up (momentary-safe). */
export function ActionBtn({ id, children, ...rest }: Omit<Parameters<typeof Btn>[0], "onPointerDown" | "onPointerUp"> & { id: string }) {
  return (
    <Btn
      {...rest}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        press(id);
      }}
      onPointerUp={() => release(id)}
      onPointerCancel={() => release(id)}
    >
      {children}
    </Btn>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, className }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={clsx("inline-flex rounded-lg border border-white/10 bg-black/30 p-0.5", className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={clsx("h-6 rounded-md px-2 text-[11px] font-medium transition-colors", o.value === value ? "bg-white/15 text-zinc-50" : "text-zinc-400 hover:text-zinc-200")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
