import { describe, expect, it } from "vitest";
import { layoutFor, ordered, reconcile, screenAt, screenLabel, setupKey, type Screen } from "../lib/screens";
import { changed } from "../lib/windowSync";

const scr = (name: string, x: number, y = 0, width = 1920, height = 1080): Screen => ({ name, x, y, width, height, scale: 1 });
const laptop = scr("Built-in Retina Display", 0, 0, 2880, 1800);
const monitor = scr("DELL U2720Q", 2880, 0, 3840, 2160);
const projector = scr("EPSON PJ", -1920);

describe("screens", () => {
  it("names a set of screens the same whatever order the system lists them in", () => {
    expect(setupKey([laptop, monitor])).toBe(setupKey([monitor, laptop]));
    expect(setupKey([laptop, monitor])).not.toBe(setupKey([laptop, projector]));
    expect(setupKey([laptop])).not.toBe(setupKey([laptop, monitor]));
  });

  it("numbers screens left to right and keeps useful names", () => {
    const all = [monitor, laptop, projector];
    expect(ordered(all).map((s) => s.name)).toEqual(["EPSON PJ", "Built-in Retina Display", "DELL U2720Q"]);
    expect(screenLabel(all, monitor)).toBe("Screen 3 (DELL U2720Q)");
    // Windows names its screens \\.\DISPLAY1, which tells nobody anything.
    expect(screenLabel([scr("\\\\.\\DISPLAY1", 0), scr("\\\\.\\DISPLAY2", 1920)], scr("\\\\.\\DISPLAY2", 1920))).toBe("Screen 2");
  });

  it("finds the screen under a point, including screens left of the main one", () => {
    const all = [laptop, monitor, projector];
    expect(screenAt(all, 100, 100)?.name).toBe(laptop.name);
    expect(screenAt(all, 3000, 2000)?.name).toBe(monitor.name);
    expect(screenAt(all, -5, 10)?.name).toBe(projector.name);
    expect(screenAt(all, 100, 5000)).toBeNull();
  });

  it("brings parts back when their screen is unplugged", () => {
    const placement = { library: monitor.name, tools: projector.name };
    expect(reconcile(placement, [laptop, monitor, projector], laptop.name)).toEqual({ keep: placement, back: [] });
    expect(reconcile(placement, [laptop, monitor], laptop.name)).toEqual({ keep: { library: monitor.name }, back: ["tools"] });
    expect(reconcile(placement, [laptop], laptop.name)).toEqual({ keep: {}, back: ["library", "tools"] });
  });

  it("puts a part on the main window's own screen back into the main window", () => {
    // The main window was dragged onto the monitor the library was on.
    expect(reconcile({ library: monitor.name }, [laptop, monitor], monitor.name)).toEqual({ keep: {}, back: ["library"] });
  });

  it("remembers a layout for each set of screens", () => {
    const saved = {
      [setupKey([laptop, monitor])]: { library: monitor.name },
      [setupKey([laptop, projector])]: { tools: projector.name },
    };
    expect(layoutFor(saved, [monitor, laptop], laptop.name)).toEqual({ library: monitor.name });
    expect(layoutFor(saved, [laptop, projector], laptop.name)).toEqual({ tools: projector.name });
    expect(layoutFor(saved, [laptop], laptop.name)).toEqual({});
  });
});

describe("window sync", () => {
  it("sends only the shared values that changed", () => {
    const mixer = { crossfader: 0 };
    const prev = { mixer, workspace: "mix", set: () => undefined };
    expect(changed("app", { ...prev, workspace: "library" }, prev)).toBeNull();
    const next = { ...prev, mixer: { crossfader: 0.5 } };
    expect(changed("app", next, prev)).toEqual({ mixer: { crossfader: 0.5 } });
  });

  it("shares every value of the sequencer but the page you are looking at", () => {
    const prev = { on: false, page: 0, steps: 16 };
    expect(changed("seq", { ...prev, page: 1 }, prev)).toBeNull();
    expect(changed("seq", { ...prev, on: true }, prev)).toEqual({ on: true });
  });
});
