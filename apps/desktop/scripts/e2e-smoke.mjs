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
