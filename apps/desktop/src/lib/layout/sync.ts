// Keeping every window on the same layout. Only the main window changes it: a part window
// sends the operation it wants as an intent, the main window applies it to the layout as
// it is then and sends the whole result, numbered, to every window. A window draws a
// layout only if its number is higher than the last one it drew, so a late or repeated
// message can never take it back to an older one.
import type { Env, Layout } from "./model";
import { isRefusal, run, type Op } from "./ops";
import { serialise } from "./persist";

/** The main window's news: the whole layout, numbered. */
export interface LayoutMessage {
  kind: "layout";
  seq: number;
  layout: Layout;
}

/** A part window's request. `id` lets the answer find its way back. */
export interface IntentMessage {
  kind: "intent";
  id: string;
  from: string;
  /** The layout number the window was looking at when it asked. */
  basedOn: number;
  op: Op;
}

/** The main window's answer to an intent that was turned down. */
export interface RefusedMessage {
  kind: "refused";
  id: string;
  to: string;
  reason: string;
}

/** The part window side: draws only newer layouts. */
export class LayoutFeed {
  private last = -1;
  /** True when the message is newer than anything drawn, and so should be drawn. */
  accept(m: LayoutMessage): boolean {
    if (!Number.isInteger(m.seq) || m.seq <= this.last) return false;
    this.last = m.seq;
    return true;
  }
  get seq() {
    return this.last;
  }
}

/** The main window side: applies operations in order and numbers each result. */
export class LayoutWriter {
  constructor(
    private layout: Layout,
    private seq = 0,
  ) {}

  get current(): LayoutMessage {
    return { kind: "layout", seq: this.seq, layout: this.layout };
  }

  /**
   * Applies one operation to the layout as it is now (not as the asking window saw it).
   * Returns the new layout to send, nothing when it changed nothing, or the reason it was
   * turned down.
   */
  apply(op: Op, env: Env): { sent: LayoutMessage } | { unchanged: true } | { refused: string } {
    const next = run(this.layout, env, op);
    if (isRefusal(next)) return { refused: next.reason };
    // Folding something already folded and the like: nothing to send, and no new number.
    if (next === this.layout || serialise(next) === serialise(this.layout)) return { unchanged: true };
    this.layout = next;
    this.seq++;
    return { sent: this.current };
  }

  /** Replaces the layout (a preset, a screen change, a load) and numbers it. */
  replace(layout: Layout): LayoutMessage {
    this.layout = layout;
    this.seq++;
    return this.current;
  }
}
