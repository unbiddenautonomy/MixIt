// The coach behind the lightbulb (components/shell/Coach.tsx): the count, Pop up, Only
// when I ask and Off, an info tip closing by itself, a warning staying, Hide this tip.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tip } from "../lib/coach";

const tips = vi.hoisted(() => ({ now: [] as Tip[] }));
vi.mock("../lib/coach", async (orig) => ({ ...(await orig<object>()), coachTips: () => tips.now }));

import { CoachButton, coachMode, coachSettings, newTip, visibleTips, COACH_INFO_MS } from "../components/shell/Coach";
import { useApp } from "../store/app";

const info: Tip = { id: "bass", level: "info", text: "Both basses are up." };
const warn: Tip = { id: "vocals", level: "warn", text: "Two voices at once.", action: { label: "Lower mids B", run: "mid-cut", arg: [1] } };

let root: Root;
let host: HTMLDivElement;
const setMode = (coach: boolean, coachPopup: boolean) => useApp.setState({ settings: { ...(useApp.getState().settings ?? {}), coach, coachPopup } as never, workspace: "mix" });
const card = () => document.querySelector('[data-testid="coach"]');
const count = () => host.querySelector('[data-testid="coach-count"]')?.textContent ?? null;
const step = async (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(CoachButton)));
}

describe("the coach's choices", () => {
  it("maps the settings to the three choices and back", () => {
    for (const m of ["popup", "ask", "off"] as const) expect(coachMode(coachSettings(m))).toBe(m);
    expect(coachMode({ coach: true, coachPopup: undefined })).toBe("ask");
    expect(coachMode(null)).toBe("off");
  });

  it("pops up only what is new, and leaves hidden tips out", () => {
    expect(newTip([info, warn], new Set(["bass"]))).toBe(warn);
    expect(newTip([info], new Set(["bass"]))).toBeNull();
    expect(visibleTips([info, warn], new Set(["vocals"]))).toEqual([info]);
  });
});

describe("the lightbulb", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    tips.now = [];
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("counts the tips and waits to be asked", async () => {
    setMode(true, false);
    tips.now = [info, warn];
    await mount();
    await step(600);
    expect(count()).toBe("2");
    expect(card()).toBeNull();
    await act(async () => (host.querySelector('[data-testid="coach-button"]') as HTMLElement).click());
    expect(card()?.textContent).toContain("Both basses are up.");
    // Hiding a tip keeps it away for the session.
    const hide = [...card()!.querySelectorAll("button")].find((b) => b.textContent === "Hide this tip")!;
    await act(async () => hide.click());
    await step(600);
    expect(count()).toBe("1");
    expect(card()?.textContent).toContain("Two voices at once.");
  });

  it("says so when there is nothing to point out", async () => {
    setMode(true, false);
    await mount();
    expect(count()).toBeNull();
    await act(async () => (host.querySelector('[data-testid="coach-button"]') as HTMLElement).click());
    expect(card()?.textContent).toContain("Nothing to point out right now");
  });

  it("pops up a new tip by itself without taking the keyboard, and lets a hint go again", async () => {
    setMode(true, true);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await mount();
    tips.now = [info];
    await step(600);
    expect(card()?.textContent).toContain("Both basses are up.");
    expect(document.activeElement).toBe(input);
    await step(COACH_INFO_MS + 100);
    expect(card()).toBeNull();
    // The same tip doesn't come back by itself; a warning does, and stays.
    tips.now = [info, warn];
    await step(600);
    expect(card()?.textContent).toContain("Two voices at once.");
    await step(COACH_INFO_MS * 3);
    expect(card()?.textContent).toContain("Two voices at once.");
    input.remove();
  });

  it("is gone when the coach is off", async () => {
    setMode(false, false);
    tips.now = [warn];
    await mount();
    await step(600);
    expect(host.querySelector('[data-testid="coach-button"]')).toBeNull();
  });
});
