// In-app replacements for window.confirm and window.prompt, which webviews either block
// or show as unstyled system boxes. `ask` and `askText` return promises; one host renders
// whichever is open.
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { Btn } from "../ui/Button";

interface Request {
  kind: "confirm" | "text" | "choose";
  title: string;
  body?: ReactNode;
  confirm: string;
  cancel: string;
  danger?: boolean;
  initial?: string;
  placeholder?: string;
  help?: ReactNode;
  /** Monospaced input, for searches and paths. */
  code?: boolean;
  /** For "choose": one button per option, the last one the main one. */
  options?: string[];
  resolve: (v: string | boolean | number | null) => void;
}

const useDialogs = create<{ queue: Request[] }>(() => ({ queue: [] }));

function open(r: Omit<Request, "resolve">): Promise<string | boolean | number | null> {
  return new Promise((resolve) => useDialogs.setState((s) => ({ queue: [...s.queue, { ...r, resolve }] })));
}

/** Asks a yes/no question. Resolves true when confirmed. */
export async function ask(opts: { title: string; body?: ReactNode; confirm?: string; cancel?: string; danger?: boolean }): Promise<boolean> {
  return (await open({ kind: "confirm", confirm: opts.confirm ?? "OK", cancel: opts.cancel ?? "Cancel", ...opts })) === true;
}

/** Asks for a line of text. Resolves null when cancelled. */
export async function askText(opts: { title: string; body?: ReactNode; initial?: string; placeholder?: string; help?: ReactNode; confirm?: string; code?: boolean }): Promise<string | null> {
  const v = await open({ kind: "text", confirm: opts.confirm ?? "Save", cancel: "Cancel", ...opts });
  return typeof v === "string" ? v : null;
}

/** Asks which of a few ways to go. Resolves the option's index, or null when cancelled. */
export async function choose(opts: { title: string; body?: ReactNode; options: string[] }): Promise<number | null> {
  const v = await open({ kind: "choose", confirm: "", cancel: "Cancel", ...opts });
  return typeof v === "number" ? v : null;
}

/** Answers every open dialog with "cancel" (tests, workspace changes). */
export function dismissDialogs() {
  const q = useDialogs.getState().queue;
  useDialogs.setState({ queue: [] });
  q.forEach((r) => r.resolve(r.kind === "confirm" ? false : null));
}

export function DialogHost() {
  const req = useDialogs((s) => s.queue[0]);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (req?.kind === "text") setText(req.initial ?? "");
  }, [req]);
  const finish = (v: string | boolean | number | null) => {
    if (!req) return;
    useDialogs.setState((s) => ({ queue: s.queue.slice(1) }));
    req.resolve(v);
  };
  const ok = () => finish(req?.kind === "text" ? text : true);
  const cancel = () => finish(req?.kind === "confirm" ? false : null);
  return (
    <Dialog.Root open={!!req} onOpenChange={(o) => !o && cancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          onOpenAutoFocus={(e) => {
            if (req?.kind === "text") {
              e.preventDefault();
              window.setTimeout(() => input.current?.select(), 0);
            }
          }}
          className="fixed left-1/2 top-1/2 z-[61] flex w-[min(460px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-2xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
        >
          <Dialog.Title className="text-base font-semibold text-zinc-50">{req?.title}</Dialog.Title>
          {req?.body ? <Dialog.Description className="text-sm leading-relaxed text-zinc-300">{req.body}</Dialog.Description> : <Dialog.Description className="sr-only">{req?.title}</Dialog.Description>}
          {req?.kind === "text" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                ok();
              }}
              className="flex flex-col gap-1.5"
            >
              <input ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder={req.placeholder} aria-label={req.title} className={`input h-9 text-sm ${req.code ? "font-mono" : ""}`} />
              {req.help && <div className="text-xs leading-snug text-zinc-500">{req.help}</div>}
            </form>
          )}
          <div className="mt-1 flex flex-wrap justify-end gap-2">
            <Btn onClick={cancel}>{req?.cancel}</Btn>
            {req?.kind === "choose" ? (
              req.options?.map((o, i) => (
                <Btn key={o} tone={i === (req.options?.length ?? 0) - 1 ? "accent" : undefined} onClick={() => finish(i)} autoFocus={i === (req.options?.length ?? 0) - 1}>
                  {o}
                </Btn>
              ))
            ) : (
              <Btn tone={req?.danger ? "danger" : "accent"} onClick={ok} autoFocus={req?.kind === "confirm"}>
                {req?.confirm}
              </Btn>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
