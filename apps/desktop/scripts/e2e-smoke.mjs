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
    console.log(`  FAIL ${name}: ${String(e?.message ?? e).split("\n")[0]}`);
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
    await page.hover('[data-testid="hear-mix-0"]', { force: true });
    await page.click('[data-testid="hear-mix-0"]');
    await page.waitForSelector('[data-testid="rehearsal-bar"] >> text=/as Auto DJ will play it/', { timeout: 10_000 });
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
