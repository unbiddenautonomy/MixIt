// The first-run walkthrough: about two minutes, and it ends with the person's first blend.
// It is a lab with no side panel: each step points at one control, says what it does,
// and moves on by itself when the person does it.
import { create } from "zustand";
import { audible, ch, context, playing, tele, type Lab, type Step } from "./model";

const A = 0;
const B = 1;

export const TOUR: Lab = {
  id: "tour",
  number: 0,
  title: "Your first mix",
  goal: "Play two tracks and blend from one into the other, the way club DJs do.",
  decks: ["p1", "p2"],
  steps: [
    {
      id: "play-a",
      title: "Press Play on deck A",
      body: "Each deck plays one track. Deck A is on the left. Its fader is up, so you hear it straight away.",
      controls: ["deck.A.play"],
      check: (c) => playing(c, A),
    },
    {
      id: "sync-b",
      title: "Press Sync on deck B",
      body: "Sync makes deck B play at the same speed as deck A, with its beats lined up. That is the hard part of DJing, done for you.",
      controls: ["deck.B.sync"],
      check: (c) => !!tele(c, B)?.sync,
    },
    {
      id: "play-b",
      title: "Press Play on deck B",
      body: "You will not hear it yet: deck B's volume fader is down. It plays in time with A, ready to bring in.",
      controls: ["deck.B.play"],
      check: (c) => playing(c, B),
    },
    {
      id: "bass-down",
      title: "Turn deck B's Low knob all the way down",
      body: "Low is the bass. Two basslines at once sound muddy, so the new track comes in without its bass. Drag the knob down, or scroll on it.",
      controls: ["mixer.B.eq.low"],
      check: (c) => ch(c, B).low <= -15 || ch(c, B).kills[0],
    },
    {
      id: "fader-up",
      title: "Slowly raise deck B's volume fader",
      body: "Take a few seconds. Now both tracks play together: deck A's bass and deck B's drums and melody.",
      controls: ["mixer.B.fader"],
      check: (c) => ch(c, B).fader >= 0.8 && audible(c, B) > 0.5,
    },
    {
      id: "swap",
      title: "Swap the basslines",
      body: "On the first beat of a bar (count 1-2-3-4), turn deck A's Low down and deck B's Low back up. The new track now carries the bass.",
      controls: ["mixer.A.eq.low", "mixer.B.eq.low"],
      check: (c) => (ch(c, A).low <= -15 || ch(c, A).kills[0]) && ch(c, B).low >= -4 && !ch(c, B).kills[0],
    },
    {
      id: "fade-a",
      title: "Pull deck A's volume fader down",
      body: "Deck A fades away and deck B is playing on its own. That was a blend.",
      controls: ["mixer.A.fader"],
      check: (c) => audible(c, A) < 0.1 && audible(c, B) > 0.5,
    },
  ],
  listen: "Listen for the moment the bass changes over: the mix should never get louder or muddier.",
  mistake: "Bringing the new track in with its bass up.",
};

const STORE = "mixit.tour.v1";

function seen(): boolean {
  try {
    return localStorage.getItem(STORE) !== null;
  } catch {
    return true;
  }
}

export function markSeen(how: "done" | "skipped") {
  try {
    localStorage.setItem(STORE, how);
  } catch {
    // Without storage the welcome may show again next time; nothing else depends on it.
  }
}

type Phase = "welcome" | "setup" | "steps" | "done";

interface TourState {
  phase: Phase | null;
  index: number;
  set: (p: Partial<{ phase: Phase | null; index: number }>) => void;
}

export const useTour = create<TourState>((set) => ({ phase: null, index: 0, set: (p) => set(p) }));

/** Shows the welcome on first run (not in tests or when the guide was used before). */
export function maybeWelcome() {
  if (!seen()) useTour.getState().set({ phase: "welcome", index: 0 });
}

export function startTour() {
  useTour.getState().set({ phase: "welcome", index: 0 });
}

/** Ticks the tour on: returns the step now showing. */
export function advance(): Step | undefined {
  const s = useTour.getState();
  if (s.phase !== "steps") return undefined;
  const c = context(TOUR.id);
  let i = s.index;
  while (i < TOUR.steps.length) {
    const step = TOUR.steps[i];
    let ok = false;
    try {
      ok = !!step.check?.(c);
    } catch {
      ok = false;
    }
    if (!ok) break;
    i++;
  }
  if (i !== s.index) s.set({ index: i });
  if (i >= TOUR.steps.length) {
    s.set({ phase: "done" });
    markSeen("done");
    return undefined;
  }
  return TOUR.steps[i];
}
