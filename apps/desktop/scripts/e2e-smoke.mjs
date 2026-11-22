// End-to-end smoke test of the UI in a real browser, on the demo backend (no Rust
// build needed). It walks through the main flows (library, searching, sounds like,
// building a set, tidying details, the decks, an instant double, Arrange, settings, the
// palette and the guide) and fails on any broken step or console error.
//
//   npm run e2e                              # starts the vite dev server itself
//   node scripts/e2e-smoke.mjs --url http://localhost:5173/   # against a running dev server
//
// It uses the dev build because only that exposes the stores to the page (window.mixit).
//
// Needs Playwright with Chromium (`npm i --no-save playwright && npx playwright install chromium`).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const urlArg = args.includes("--url") ? args[args.indexOf("--url") + 1] : null;
const headed = args.includes("--headed");
const PORT = 4180;

let server = null;
async function startServer() {
  if (urlArg) return urlArg;
  server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
  server.stderr.on("data", (d) => process.stderr.write(d));
  const url = `http://localhost:${PORT}/`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return url;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("the vite dev server did not start");
}

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ok   ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: String(e?.message ?? e) });
    // A picture of the page as it failed (CI keeps these).
    await page?.screenshot({ path: `e2e-fail-${results.length}.png` }).catch(() => {});
    // The first lines, with Playwright's call log (what it was waiting for).
    console.log(`  FAIL ${name}: ${String(e?.message ?? e).split("\n").slice(0, 16).join("\n       ")}`);
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const base = await startServer();
const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`page: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
await page.addInitScript(() => localStorage.setItem("mixit.tour.v1", "skip"));

const lib = () => page.evaluate(() => window.mixit.useLibrary.getState());
const libField = (f) => page.evaluate((f) => window.mixit.useLibrary.getState()[f], f);

try {
  console.log(`MixIt end-to-end smoke test on ${base}`);

  await step("the app starts on the demo library", async () => {
    await page.goto(`${base}?demo`);
    await page.waitForFunction(() => window.mixit && window.mixit.useApp.getState().registry.length > 0, null, { timeout: 30_000 });
    await sleep(1000);
    await page.keyboard.press("Escape");
  });

  await step("the library lists tracks and searches them", async () => {
    await page.click('button:has-text("Library")');
    await page.waitForSelector('[data-testid="track-table"] [data-track]');
    const all = (await libField("rows")).length;
    expect(all > 20, `only ${all} rows`);
    await page.fill('input[placeholder^="Search"]', "bpm:120-126");
    await sleep(700);
    const rows = await libField("rows");
    expect(rows.length > 0 && rows.length < all, `search gave ${rows.length} of ${all}`);
    expect(
      rows.every((r) => r.bpm >= 120 && r.bpm <= 126),
      "a row outside 120–126 BPM",
    );
    await page.fill('input[placeholder^="Search"]', "");
    await sleep(500);
  });

  await step("vocals:no finds instrumentals and the panel says so", async () => {
    await page.fill('input[placeholder^="Search"]', "vocals:no");
    await sleep(700);
    const rows = await libField("rows");
    expect(rows.length > 0 && rows.every((r) => r.vocals != null && r.vocals < 5), `vocals:no gave ${rows.length} rows`);
    await page.fill('input[placeholder^="Search"]', "vocals:yes");
    await sleep(700);
    await page.locator('[data-testid="track-table"] [data-track]').first().click();
    await page.waitForSelector('[data-testid="inspector-vocals"]:has-text("Singing")', { timeout: 5000 });
    await page.fill('input[placeholder^="Search"]', "");
    await sleep(500);
  });

  await step("the collection overview draws", async () => {
    await page.click("text=At a glance");
    await page.waitForSelector("text=Your collection at a glance");
    expect((await page.locator("svg").count()) > 3, "no charts");
  });

  await step("Fix library checks missing files, duplicates and messy details", async () => {
    // The sidebar shows Fix library only when something needs fixing; open it directly.
    await page.evaluate(() => window.mixit.useLibrary.getState().set({ source: { type: "care" } }));
    await page.waitForSelector('[data-testid="library-care"]');
    await page.waitForSelector("text=Messy details");
  });

  await step("Sounds like lists matches, best first", async () => {
    await page.click("text=Collection");
    await page.waitForSelector('[data-testid="track-table"] [data-track]');
    const row = page.locator('[data-testid="track-table"] [data-track]').nth(1);
    await row.click();
    await row.click({ button: "right" });
    await page.click('[data-testid="menu-sounds-like"]');
    await sleep(800);
    const s = await lib();
    expect(s.source.type === "similar", `source is ${s.source.type}`);
    expect(s.rows.length > 0, "no matches");
    const scores = s.rows.map((r) => s.matches[r.id]);
    expect(
      scores.every((x, i) => i === 0 || scores[i - 1] >= x),
      "not best first",
    );
  });

  await step("Build a set fills an hour of instrumentals and saves it", async () => {
    await page.click('button[title^="Build a set"]');
    await page.waitForSelector('[data-testid="build-set-dialog"]');
    await page.click('[data-testid="shape-journey"]');
    await page.click('[data-testid="set-vocals"] button:has-text("Instrumentals only")');
    await page.click('[data-testid="build-go"]');
    await page.waitForSelector('[data-testid="built-set"]');
    const n = await page.locator('[data-testid="built-set"] li').count();
    expect(n >= 10, `only ${n} tracks`);
    const before = (await libField("playlists")).length;
    await page.click('[data-testid="build-save"]');
    await sleep(800);
    const s = await lib();
    expect(s.playlists.length === before + 1, "no playlist saved");
    expect(s.source.type === "playlist" && s.rows.length === n, `saved list shows ${s.rows.length} rows`);
    const singing = s.rows.filter((r) => r.vocals == null || r.vocals >= 5).length;
    expect(singing === 0, `${singing} tracks with singing in an instrumental set`);
  });

  await step("Tidy details shows changes before applying them", async () => {
    await page.evaluate(async () => {
      const b = window.mixit.backend();
      const rows = await b.search("");
      await b.editTrack(rows[0].id, { title: "MESSY   TITLE [Free Download]" });
    });
    await page.click("text=Collection");
    await sleep(500);
    await page.keyboard.press("Control+k");
    await page.keyboard.type("Tidy track details");
    await page.keyboard.press("Enter");
    await page.waitForSelector('[data-testid="tidy-dialog"]');
    await page.waitForSelector('[data-testid="tidy-changes"]');
    await page.click('[data-testid="tidy-apply"]');
    await sleep(600);
    const fixed = await page.evaluate(async () => (await window.mixit.backend().search("")).some((r) => r.title === "Messy Title"));
    expect(fixed, "the title was not tidied");
  });

  await step("a deck loads and plays a track", async () => {
    await page.click('button:has-text("Mix")');
    await sleep(500);
    await page.evaluate(async () => {
      const b = window.mixit.backend();
      const rows = await b.search("");
      window.mixit.useApp.getState().setDeck(await b.loadTrack(0, rows.find((r) => r.bpm).id));
      await b.action("deck.A.play", { type: "press" });
      await b.action("deck.A.play", { type: "release" });
    });
    await sleep(1500);
    const t = await page.evaluate(() => window.mixit.useTelemetry.getState().t.decks[0]);
    expect(t.loaded && t.playing && t.position > 0.5, `deck A: loaded ${t.loaded}, playing ${t.playing}, at ${t.position}`);
  });

  await step("an instant double copies deck A to deck B in time", async () => {
    await page.click('[data-testid="deck-menu-B"]');
    await page.click('[data-testid="double-A-B"]');
    await sleep(1000);
    const [a, b] = await page.evaluate(() => window.mixit.useTelemetry.getState().t.decks.slice(0, 2));
    expect(b.loaded && b.playing && b.sync, "deck B is not playing in sync");
    expect(Math.abs(a.position - b.position) < 0.3, `A at ${a.position}, B at ${b.position}`);
  });

  await step("the safety loop holds the end of a lone track, and Let it end plays it out", async () => {
    await page.evaluate(async () => {
      const b = window.mixit.backend();
      await b.action("deck.B.play", { type: "press" });
      await b.action("deck.B.play", { type: "release" });
      const d = window.mixit.useTelemetry.getState().t.decks[0];
      await b.seek(0, d.duration - 6);
    });
    await page.waitForSelector('[data-testid="safety-note-A"]', { timeout: 5000 });
    await sleep(7000);
    let a = await page.evaluate(() => window.mixit.useTelemetry.getState().t.decks[0]);
    expect(a.playing && a.safetyLoop && a.position < a.duration - 0.5, `deck A: playing ${a.playing}, safety ${a.safetyLoop}, at ${a.position} of ${a.duration}`);
    await page.click('[data-testid="let-end-A"]');
    await page.waitForSelector('[data-testid="safety-note-A"]', { state: "detached", timeout: 3000 });
    await sleep(9000);
    a = await page.evaluate(() => window.mixit.useTelemetry.getState().t.decks[0]);
    expect(!a.playing, `deck A should have played out, at ${a.position} of ${a.duration}`);
  });

  await step("Arrange opens", async () => {
    await page.click('button:has-text("Arrange")');
    await sleep(600);
    expect((await page.evaluate(() => window.mixit.useApp.getState().workspace)) === "arrange", "not in Arrange");
  });

  await step("the palette finds commands", async () => {
    await page.keyboard.press("Control+k");
    await page.waitForSelector("[cmdk-input]");
    await page.keyboard.type("Build a set");
    await page.waitForSelector("[cmdk-item]:has-text('Build a set')");
    await page.fill("[cmdk-input]", "instrumentals");
    await page.waitForSelector("[cmdk-item]:has-text('Show instrumentals')");
    await page.fill("[cmdk-input]", "set length");
    await page.waitForSelector("[cmdk-item]:has-text('Set length: 1 hour')");
    await page.keyboard.press("Escape");
  });

  await step("the set clock counts down an hour", async () => {
    await page.click('[data-testid="set-clock"]');
    await page.click('[data-testid="set-length-60"]');
    await page.waitForSelector('[data-testid="set-clock"]:has-text("left")', { timeout: 3000 });
    const label = await page.textContent('[data-testid="set-clock"]');
    expect(/(59|1:00):\d\d left/.test(label ?? ""), `set clock shows ${label}`);
    await page.click("text=Clear");
    await page.keyboard.press("Escape");
  });

  await step("settings open, with fader start under Mixing", async () => {
    await page.evaluate(() => window.mixit.useApp.getState().set({ settingsOpen: true }));
    await page.waitForSelector('[role="dialog"] >> text=Settings', { timeout: 5000 });
    await page.click('[role="tab"]:has-text("Mixing")');
    await page.waitForSelector("text=Fader start", { timeout: 5000 });
    await page.keyboard.press("Escape");
  });

  await step("the guide finds a topic", async () => {
    await page.evaluate(() => window.mixit.useApp.getState().set({ guideOpen: true }));
    await page.fill('input[aria-label="Search the guide"]', "build a set");
    await page.waitForSelector("text=Building a set for a night", { timeout: 5000 });
  });

  await step("the vocals lab loads two singing practice tracks", async () => {
    await page.keyboard.press("Escape");
    await page.evaluate(async () => {
      const { setupLab } = await import("/src/guide/setup.ts");
      const { labById } = await import("/src/guide/labs.ts");
      window.__lab = setupLab(labById("vocals"));
    });
    // MixIt asks before making the practice tracks.
    await page.click('button:has-text("Add practice tracks")', { timeout: 5000 });
    const ok = await page.evaluate(() => window.__lab);
    expect(ok, "the lab did not set up");
    await page.waitForFunction(() => window.mixit.useApp.getState().decks[1]?.detail.track.title.startsWith("Practice 8"), null, { timeout: 10_000 }).catch(() => {});
    const decks = await page.evaluate(() => window.mixit.useApp.getState().decks.slice(0, 2).map((d) => [d?.detail.track.title, d?.detail.vocals?.length ?? 0]));
    expect(decks[0][0] === "Practice 7 - Vocal House" && decks[1][0] === "Practice 8 - Vocal Deep House", `decks hold ${decks.map((d) => d[0])}`);
    expect(decks.every((d) => d[1] > 0), "a practice track without vocal parts");
  });

  await step("Mix it waits for deck A's sung line to end", async () => {
    const r = await page.evaluate(async () => {
      const b = window.mixit.backend();
      const d = window.mixit.useApp.getState().decks[0].detail;
      const period = d.beatPeriod;
      // A line is sung over the first half of the drop: a bar before the drop, the next
      // phrase (the drop itself) lands on the line, and the one after it is where it ends.
      const drop = d.sections.find((s) => s.label === "Drop");
      const line = d.vocals.find(([s]) => Math.abs(s - (drop.start + 2 * period)) < 0.01);
      if (!window.mixit.useTelemetry.getState().t.decks[0].playing) {
        await b.action("deck.A.play", { type: "press" });
        await b.action("deck.A.play", { type: "release" });
      }
      await b.seek(0, drop.start - 4 * period);
      await new Promise((ok) => setTimeout(ok, 300));
      const { startTransition, cancelTransition, useTransition } = await import("/src/lib/transition.ts");
      await startTransition(0, 1, "blend", 16);
      const t = window.mixit.useTelemetry.getState().t.decks[0];
      const start = useTransition.getState().running?.startBeat;
      const startSeconds = t.position + ((start - t.beat) * 60) / t.baseBpm;
      cancelTransition();
      await b.action("deck.A.play", { type: "press" });
      await b.action("deck.A.play", { type: "release" });
      return { start, startSeconds, lineEnd: line[1], playing: t.playing };
    });
    expect(r.playing, "deck A was not playing");
    expect(Math.abs(r.startSeconds - r.lineEnd) < 1.5, `the mix starts at ${r.startSeconds.toFixed(2)} s, the line ends at ${r.lineEnd.toFixed(2)} s`);
    const said = await page
      .waitForFunction(() => /Deck A is singing, so the mix waits/.test(document.querySelector("[data-sonner-toaster]")?.textContent ?? ""), null, { timeout: 3000 })
      .then(() => true)
      .catch(() => page.evaluate(() => document.querySelector("[data-sonner-toaster]")?.textContent ?? "no toaster"));
    expect(said === true, `no message about waiting; toasts: ${said}`);
  });

  await step("Hear this mix plays a queued transition in the preview player", async () => {
    const names = await page.evaluate(async () => {
      const b = window.mixit.backend();
      // Nothing on air, so the preview may play on the speakers (there is no headphone output here).
      for (const [i, d] of window.mixit.useTelemetry.getState().t.decks.entries()) {
        if (!d.playing) continue;
        await b.action(`deck.${"ABCD"[i]}.play`, { type: "press" });
        await b.action(`deck.${"ABCD"[i]}.play`, { type: "release" });
      }
      const rows = (await b.search("")).filter((r) => r.bpm && r.duration > 120 && !r.missing).slice(0, 3);
      window.mixit.useAutoDj.getState().set({ queue: rows });
      window.mixit.useApp.getState().set({ workspace: "library" });
      window.mixit.useLibrary.getState().set({ source: { type: "autodj" } });
      return rows.map((r) => r.title);
    });
    // Telemetry lags the stop: wait until no deck is on air, or the preview refuses to play.
    await page.waitForFunction(() => window.mixit.useTelemetry.getState().t.decks.every((d) => !d.playing), null, { timeout: 3000 });
    await page.hover('[data-testid="hear-mix-0"]', { force: true });
    await page.click('[data-testid="hear-mix-0"]');
    await page.waitForSelector('[data-testid="rehearsal-bar"] >> text=/the way Auto DJ mixes it/', { timeout: 10_000 });
    const bar = await page.textContent('[data-testid="rehearsal-bar"]');
    expect(bar.includes(`${names[0]} into ${names[1]}`), `the bar says ${bar}`);
    await sleep(1200);
    let p = await page.evaluate(() => window.mixit.useTelemetry.getState().t.preview);
    expect(p.playing && p.position > 0.5, `preview: playing ${p.playing}, at ${p.position}`);
    const mixAt = await page.evaluate(() => window.mixit.useRehearse.getState().mixAt);
    await page.click('[data-testid="rehearsal-bar"] >> text="Jump to the mix"');
    await sleep(300);
    p = await page.evaluate(() => window.mixit.useTelemetry.getState().t.preview);
    expect(Math.abs(p.position - (mixAt - 4)) < 1, `jumped to ${p.position}, the mix is at ${mixAt}`);
    await page.click('[aria-label="Stop hearing the mix"]');
    await page.waitForSelector('[data-testid="rehearsal-bar"]', { state: "detached", timeout: 3000 });
    await sleep(300);
    p = await page.evaluate(() => window.mixit.useTelemetry.getState().t.preview);
    expect(!p.playing, "the preview kept playing after closing");
  });

  await step("the Auto DJ queue grades each change, fills a rough one and finds the best order", async () => {
    const pair = await page.evaluate(async () => {
      const { transition } = await import("/src/lib/setFlow.ts");
      const rows = (await window.mixit.backend().search("")).filter((r) => r.bpm && r.key && !r.missing);
      for (const a of rows)
        for (const b of rows) if (a.id !== b.id && transition(a, b).grade === "rough" && Math.abs(a.bpm / b.bpm - 1) < 0.14) return [a, b];
      return null;
    });
    expect(pair, "no rough pair in the demo library");
    await page.evaluate((q) => window.mixit.useAutoDj.getState().set({ queue: q }), pair);
    await page.waitForSelector('[data-testid="mix-link-0"][data-grade="rough"]', { timeout: 3000 });
    await page.click('[data-testid="bridge-0"]');
    const q = await page.evaluate(() => window.mixit.useAutoDj.getState().queue.map((t) => t.id));
    expect(q.length === 3 && q[0] === pair[0].id && q[2] === pair[1].id, `queue is ${q}`);
    const grades = await page.$$eval('[data-testid^="mix-link-"]', (els) => els.map((e) => e.getAttribute("data-grade")));
    expect(grades.length === 2 && !grades.includes("rough"), `grades ${grades}`);
    // Best order: a shuffled queue comes out with no more rough changes than it had.
    const before = await page.evaluate(async () => {
      const { flow, summary } = await import("/src/lib/setFlow.ts");
      const rows = (await window.mixit.backend().search("")).filter((r) => r.bpm && r.key && !r.missing).slice(0, 7);
      window.mixit.useAutoDj.getState().set({ queue: rows });
      return summary(flow(rows)).rough;
    });
    await page.click('[data-testid="queue-order"]');
    const after = await page.evaluate(async () => {
      const { flow, summary } = await import("/src/lib/setFlow.ts");
      const q = window.mixit.useAutoDj.getState().queue;
      return { rough: summary(flow(q)).rough, n: q.length };
    });
    expect(after.n === 7 && after.rough <= before, `rough changes ${before} before, ${after.rough} after`);
    await page.evaluate(() => window.mixit.useAutoDj.getState().set({ queue: [] }));
  });

  await step("a transition loops the end of a short track and still runs its full length", async () => {
    const plan = await page.evaluate(async () => {
      const b = window.mixit.backend();
      const tele = () => window.mixit.useTelemetry.getState().t.decks;
      for (const [i, d] of tele().entries()) {
        if (!d.playing) continue;
        await b.action(`deck.${"ABCD"[i]}.play`, { type: "press" });
        await b.action(`deck.${"ABCD"[i]}.play`, { type: "release" });
      }
      await b.seek(0, tele()[0].duration - 14);
      await b.action("deck.A.play", { type: "press" });
      await b.action("deck.A.play", { type: "release" });
      await new Promise((ok) => setTimeout(ok, 300));
      const d = tele()[0];
      const atBeat = Math.ceil((d.beat + 1) / 4) * 4;
      const { startTransition } = await import("/src/lib/transition.ts");
      // 16 beats of blend over an 8-beat loop: twice round the loop.
      await startTransition(0, 1, "blend", 16, { atBeat, loopBeats: 8 });
      return { atBeat, bpm: d.bpm, duration: d.duration };
    });
    const loopFor = ((8 * 60) / plan.bpm) * 1000;
    await sleep(loopFor * 1.4);
    let a = await page.evaluate(() => window.mixit.useTelemetry.getState().t.decks[0]);
    const running = await page.evaluate(() => window.mixit.useTransition.getState().running);
    expect(a.playing && a.looping.active && a.looping.beats === 8, `deck A: playing ${a.playing}, loop ${JSON.stringify(a.looping)}`);
    expect(running && running.progress > 0.2 && running.progress < 1, `transition ${JSON.stringify(running)}`);
    // It finishes after the full 16 beats even though deck A keeps jumping back.
    await page.waitForFunction(() => !window.mixit.useTransition.getState().running, null, { timeout: 20_000 });
    await sleep(400);
    const [aa, bb] = await page.evaluate(() => window.mixit.useTelemetry.getState().t.decks.slice(0, 2));
    expect(!aa.playing && !aa.looping.active, `deck A after the mix: playing ${aa.playing}, loop ${aa.looping.active}`);
    expect(bb.playing && bb.master, "deck B is not playing as the master");
    await page.evaluate(async () => {
      await window.mixit.backend().action("deck.B.play", { type: "press" });
      await window.mixit.backend().action("deck.B.play", { type: "release" });
    });
    // Play is a toggle: let the decks report stopped before the next step reads them.
    await page.waitForFunction(() => window.mixit.useTelemetry.getState().t.decks.every((d) => !d.playing), null, { timeout: 3000 });
  });

  await step("a suggestion can be heard mixed in after the seed track", async () => {
    await page.evaluate(async () => {
      const b = window.mixit.backend();
      for (const [i, d] of window.mixit.useTelemetry.getState().t.decks.entries()) {
        if (!d.playing) continue;
        await b.action(`deck.${"ABCD"[i]}.play`, { type: "press" });
        await b.action(`deck.${"ABCD"[i]}.play`, { type: "release" });
      }
      window.mixit.useApp.getState().set({ workspace: "library" });
      window.mixit.useLibrary.getState().set({ source: { type: "suggest" } });
    });
    await page.waitForSelector('[data-testid="hear-suggestion-0"]', { timeout: 10_000 });
    await page.click('[data-testid="hear-suggestion-0"]');
    await page.waitForSelector('[data-testid="rehearsal-bar"] >> text=/the way Auto DJ mixes it/', { timeout: 10_000 });
    await sleep(800);
    const p = await page.evaluate(() => window.mixit.useTelemetry.getState().t.preview);
    expect(p.playing && p.position > 0.3, `preview: playing ${p.playing}, at ${p.position}`);
    expect((await page.textContent('[data-testid="hear-suggestion-0"]')).includes("Hearing"), "the button does not show it is playing");
    await page.click('[data-testid="hear-suggestion-0"]');
    await page.waitForSelector('[data-testid="rehearsal-bar"]', { state: "detached", timeout: 3000 });
  });

  await step("Rehearse the set plays every change in the queue, one after another", async () => {
    await page.evaluate(async () => {
      const rows = (await window.mixit.backend().search("")).filter((r) => r.bpm && r.duration > 120 && !r.missing).slice(0, 4);
      window.mixit.useAutoDj.getState().set({ queue: rows });
      window.mixit.useLibrary.getState().set({ source: { type: "autodj" } });
    });
    await page.click('[data-testid="rehearse-set"]');
    await page.waitForSelector('[data-testid="now-hearing"] >> text=/Change 1 of 3/', { timeout: 15_000 });
    const st = await page.evaluate(() => window.mixit.useRehearse.getState());
    expect(st.status === "ready" && st.changes.length === 3 && st.title === "The whole set: 3 changes", `rehearsal ${st.status}, ${st.changes.length} changes, ${st.title}`);
    // Next change goes to just before the second change, and the bar follows.
    await page.click('[data-testid="next-change"]');
    await page.waitForSelector('[data-testid="now-hearing"] >> text=/Change 2 of 3/', { timeout: 3000 });
    const p = await page.evaluate(() => window.mixit.useTelemetry.getState().t.preview);
    expect(p.playing && Math.abs(p.position - (st.changes[1].at - 4)) < 1, `at ${p.position}, change 2 at ${st.changes[1].at}`);
    await page.click('[aria-label="Stop hearing the mix"]');
    await page.waitForSelector('[data-testid="rehearsal-bar"]', { state: "detached", timeout: 3000 });
    await page.evaluate(() => window.mixit.useAutoDj.getState().set({ queue: [] }));
  });

  await step("Mix it on Smart picks the transition and says why", async () => {
    await page.evaluate(async () => {
      const b = window.mixit.backend();
      window.mixit.useApp.getState().set({ workspace: "mix" });
      await b.seek(0, 40);
      await b.action("deck.A.play", { type: "press" });
      await b.action("deck.A.play", { type: "release" });
    });
    await page.waitForFunction(() => window.mixit.useTelemetry.getState().t.decks[0].playing, null, { timeout: 3000 });
    expect((await page.inputValue('[data-testid="mix-kind"]')) === "smart", "Mix it is not on Smart by default");
    await page.click('[data-testid="mix-it"]');
    await page.waitForFunction(() => window.mixit.useTransition.getState().running, null, { timeout: 5000 });
    const r = await page.evaluate(() => ({ run: window.mixit.useTransition.getState().running, beat: window.mixit.useTelemetry.getState().t.decks[0].beat, toasts: document.querySelector("[data-sonner-toaster]")?.textContent ?? "" }));
    expect(r.run.from === 0 && r.run.to === 1 && r.run.startBeat > r.beat && r.run.startBeat % 4 === 0, `transition ${JSON.stringify(r.run)} at beat ${r.beat}`);
    expect(/over \d+ beats|Cut on the bar|Brake stop/.test(r.toasts), `no plan message: ${r.toasts}`);
    await page.evaluate(async () => {
      const { cancelTransition } = await import("/src/lib/transition.ts");
      cancelTransition();
      const b = window.mixit.backend();
      for (const [i, d] of window.mixit.useTelemetry.getState().t.decks.entries()) {
        if (!d.playing) continue;
        await b.action(`deck.${"ABCD"[i]}.play`, { type: "press" });
        await b.action(`deck.${"ABCD"[i]}.play`, { type: "release" });
      }
    });
    await page.waitForFunction(() => window.mixit.useTelemetry.getState().t.decks.every((d) => !d.playing), null, { timeout: 3000 });
  });

  await step("Hear it first plays Mix it's mix in the headphones, never on the speakers", async () => {
    await page.evaluate(async () => {
      const b = window.mixit.backend();
      await b.seek(0, 40);
      await b.action("deck.A.play", { type: "press" });
      await b.action("deck.A.play", { type: "release" });
    });
    await page.waitForFunction(() => window.mixit.useTelemetry.getState().t.decks[0].playing, null, { timeout: 3000 });
    // On the speakers, with deck A on air, the audience would hear it: it refuses.
    await page.click('[data-testid="hear-mix-it"]');
    await page.waitForFunction(() => /audience would hear it/.test(document.querySelector("[data-sonner-toaster]")?.textContent ?? ""), null, { timeout: 3000 });
    expect((await page.evaluate(() => window.mixit.useRehearse.getState().key)) === null, "a preview started on the speakers");
    await page.evaluate(async () => {
      const { useTrackPreview } = await import("/src/store/trackPreview.ts");
      useTrackPreview.setState({ route: "headphones" });
    });
    await page.click('[data-testid="hear-mix-it"]');
    await page.waitForFunction(() => window.mixit.useRehearse.getState().status === "ready", null, { timeout: 5000 });
    const st = await page.evaluate(() => window.mixit.useRehearse.getState());
    expect(st.key === "mixer" && st.duration > st.mixEnd && st.mixEnd > st.mixAt && /over \d+ beats|Cut|Brake/.test(st.summary), `rehearsal ${JSON.stringify(st)}`);
    expect(!(await page.evaluate(() => window.mixit.useTransition.getState().running)), "hearing it started the real mix");
    await page.evaluate(async () => {
      const { stopMix } = await import("/src/store/rehearse.ts");
      const { useTrackPreview } = await import("/src/store/trackPreview.ts");
      stopMix();
      useTrackPreview.setState({ route: "auto" });
      const b = window.mixit.backend();
      for (const [i, d] of window.mixit.useTelemetry.getState().t.decks.entries()) {
        if (!d.playing) continue;
        await b.action(`deck.${"ABCD"[i]}.play`, { type: "press" });
        await b.action(`deck.${"ABCD"[i]}.play`, { type: "release" });
      }
    });
    await page.waitForFunction(() => window.mixit.useTelemetry.getState().t.decks.every((d) => !d.playing), null, { timeout: 3000 });
  });

  await step("Make a mix turns the Auto DJ queue into an Arrange project", async () => {
    await page.evaluate(async () => {
      const rows = (await window.mixit.backend().search("")).filter((r) => r.bpm && r.duration > 120 && !r.missing).slice(0, 3);
      window.mixit.useAutoDj.getState().set({ queue: rows });
      window.mixit.useApp.getState().set({ workspace: "mix", projectDirty: false });
      window.mixit.useLibrary.getState().set({ source: { type: "autodj" } });
    });
    await page.click('[data-testid="queue-mix"]');
    await page.waitForFunction(() => window.mixit.useApp.getState().workspace === "arrange" && window.mixit.useApp.getState().project?.markers.length === 2, null, { timeout: 10_000 });
    const p = await page.evaluate(() => {
      const pr = window.mixit.useApp.getState().project;
      return { clips: pr.clips.map((c) => ({ path: c.track.path, start: c.start, length: c.length, lanes: c.lanes.length })), markers: pr.markers, name: pr.name };
    });
    const paths = [...new Set(p.clips.map((c) => c.path))];
    expect(paths.length === 3 && p.markers[0].beat > 0 && p.markers[1].beat > p.markers[0].beat && p.clips.some((c) => c.lanes > 0) && /^Auto DJ set/.test(p.name), `project ${JSON.stringify(p)}`);
    await page.evaluate(() => {
      window.mixit.useAutoDj.getState().set({ queue: [] });
      window.mixit.useApp.getState().set({ workspace: "mix", projectDirty: false });
    });
  });

  await step("a transition chosen for one change is what Hear this mix plays", async () => {
    await page.evaluate(async () => {
      const rows = (await window.mixit.backend().search("")).filter((r) => r.bpm && r.duration > 120 && !r.missing).slice(0, 2);
      window.mixit.useAutoDj.getState().set({ queue: rows, choices: {} });
      window.mixit.useApp.getState().set({ workspace: "mix" });
      window.mixit.useLibrary.getState().set({ source: { type: "autodj" } });
    });
    await page.selectOption('[data-testid="choose-mix-0"]', "cut");
    await page.click('[data-testid="hear-mix-0"]');
    await page.waitForFunction(() => window.mixit.useRehearse.getState().status === "ready", null, { timeout: 10_000 });
    const st = await page.evaluate(() => ({ summary: window.mixit.useRehearse.getState().summary, choices: window.mixit.useAutoDj.getState().choices }));
    expect(st.summary === "Cut on the bar" && Object.values(st.choices).join() === "cut", `heard ${JSON.stringify(st)}`);
    await page.click('[aria-label="Stop hearing the mix"]');
    await page.selectOption('[data-testid="choose-mix-0"]', "");
    expect(Object.keys(await page.evaluate(() => window.mixit.useAutoDj.getState().choices)).length === 0, "Auto did not clear the choice");
    await page.evaluate(() => window.mixit.useAutoDj.getState().set({ queue: [] }));
  });

  await step("Save keeps the Auto DJ queue as a playlist", async () => {
    const want = await page.evaluate(async () => {
      const rows = (await window.mixit.backend().search("")).filter((r) => !r.missing).slice(0, 3);
      window.mixit.useAutoDj.getState().set({ queue: rows });
      window.mixit.useLibrary.getState().set({ source: { type: "autodj" } });
      return rows.map((r) => r.id);
    });
    await page.click('[data-testid="queue-save"]');
    await page.waitForSelector("text=/Saved the queue as/", { timeout: 5000 });
    const got = await page.evaluate(async () => {
      const b = window.mixit.backend();
      const list = (await b.playlists()).filter((p) => p.name.startsWith("Auto DJ set")).pop();
      return list ? (await b.playlistTracks(list.id)).map((t) => t.id) : null;
    });
    expect(JSON.stringify(got) === JSON.stringify(want), `saved ${JSON.stringify(got)}, queue ${JSON.stringify(want)}`);
    await page.evaluate(() => window.mixit.useAutoDj.getState().set({ queue: [] }));
  });

  await step("T mixes it and H hears it first, from the keyboard", async () => {
    await page.evaluate(async () => {
      const b = window.mixit.backend();
      window.mixit.useApp.getState().set({ workspace: "mix" });
      await b.seek(0, 40);
      await b.action("deck.A.play", { type: "press" });
      await b.action("deck.A.play", { type: "release" });
      const { useTrackPreview } = await import("/src/store/trackPreview.ts");
      useTrackPreview.setState({ route: "headphones" });
      document.activeElement?.blur?.();
    });
    await page.waitForFunction(() => window.mixit.useTelemetry.getState().t.decks[0].playing, null, { timeout: 3000 });
    await page.keyboard.press("h");
    await page.waitForFunction(() => window.mixit.useRehearse.getState().key === "mixer", null, { timeout: 5000 });
    expect(!(await page.evaluate(() => window.mixit.useTransition.getState().running)), "H started the real mix");
    await page.keyboard.press("t");
    await page.waitForFunction(() => window.mixit.useTransition.getState().running, null, { timeout: 5000 });
    const run = await page.evaluate(() => window.mixit.useTransition.getState().running);
    expect(run.from === 0 && run.to === 1, `T mixed ${JSON.stringify(run)}`);
    await page.evaluate(async () => {
      const { cancelTransition } = await import("/src/lib/transition.ts");
      const { stopMix } = await import("/src/store/rehearse.ts");
      const { useTrackPreview } = await import("/src/store/trackPreview.ts");
      cancelTransition();
      stopMix();
      useTrackPreview.setState({ route: "auto" });
      const b = window.mixit.backend();
      for (const [i, d] of window.mixit.useTelemetry.getState().t.decks.entries()) {
        if (!d.playing) continue;
        await b.action(`deck.${"ABCD"[i]}.play`, { type: "press" });
        await b.action(`deck.${"ABCD"[i]}.play`, { type: "release" });
      }
    });
    await page.waitForFunction(() => window.mixit.useTelemetry.getState().t.decks.every((d) => !d.playing), null, { timeout: 3000 });
  });

  await step("no errors in the console", async () => {
    expect(errors.length === 0, errors.slice(0, 5).join(" | "));
  });
} finally {
  await browser.close();
  server?.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} steps passed.`);
process.exit(failed.length ? 1 : 0);
