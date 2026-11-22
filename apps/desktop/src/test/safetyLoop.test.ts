import { describe, expect, it } from "vitest";
import { DemoBackend } from "../backend/demo";
import type { DeckTele } from "../backend/types";

// Drives the demo engine's clock by hand, 0.1 s a step.
function rig() {
  const b = new DemoBackend();
  let last: DeckTele[] = [];
  b.onTelemetry((t) => (last = t.decks));
  const step = (seconds: number) => {
    const sim = b as unknown as { last: number; tick: () => void };
    for (let i = 0; i < seconds * 10; i++) {
      sim.last = performance.now() - 100;
      sim.tick();
    }
    return last;
  };
  return { b, step };
}

async function nearTheEnd(b: DemoBackend, deck: number, id: number) {
  await b.loadTrack(deck, id);
  const dur = (await b.search("")).find((r) => r.id === id)!.duration;
  await b.seek(deck, dur - 20);
  await b.action(`deck.${"AB"[deck]}.play`, { type: "press" });
  return dur;
}

describe("the safety loop", () => {
  it("holds the end of the only track playing, until you let it end", async () => {
    const { b, step } = rig();
    const ids = (await b.search("")).filter((r) => r.duration > 120).map((r) => r.id);
    await b.action("global.safety_loop", { type: "set", value: true });
    const dur = await nearTheEnd(b, 0, ids[0]);
    let d = step(40)[0];
    expect(d.playing).toBe(true);
    expect(d.safetyLoop).toBe(true);
    expect(d.looping.active && d.looping.beats === 16).toBe(true);
    expect(d.position).toBeLessThan(dur);

    await b.action("deck.A.let_end", { type: "press" });
    d = step(30)[0];
    expect(d.playing).toBe(false);
    expect(d.safetyLoop).toBe(false);
  });

  it("stays out when it is off, or while another track is heard", async () => {
    const { b, step } = rig();
    const ids = (await b.search("")).filter((r) => r.duration > 240).map((r) => r.id);
    await nearTheEnd(b, 0, ids[0]);
    expect(step(30)[0].playing).toBe(false);

    await b.action("global.safety_loop", { type: "set", value: true });
    await b.loadTrack(1, ids[1]);
    await b.action("deck.B.play", { type: "press" });
    await nearTheEnd(b, 0, ids[2]);
    const [a, bb] = step(30);
    expect(bb.playing).toBe(true);
    expect(a.playing).toBe(false);
    expect(a.safetyLoop).toBe(false);
  });
});
