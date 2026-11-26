// Ask MixIt: a typed sentence ("cut the bass on deck B", "find instrumentals around 124
// bpm", "build a one hour warm-up set from my house playlist") turned into one of MixIt's
// own actions, with the values read out of it.
//
// No language model: phrase rules with synonym lists, written against the action
// registry, run instantly and offline. `understand` only reads; `src/lib/askRun.ts`
// does what it found. The test set in `src/test/ask.test.ts` holds phrasings checked
// against this (95 % or more must come out right), so a smaller trained model can be
// compared against it later on exactly the same sentences.
import type { ActionSpec, BuildSetRequest, SetShape, VocalPlan } from "../backend/types";

const LETTERS = ["A", "B", "C", "D"];

/** One control movement. */
export type AskStep =
  /** A trigger pressed once, or a toggle flipped. */
  | { do: "press"; id: string }
  /** A momentary control pressed and let go. */
  | { do: "tap"; id: string }
  | { do: "set"; id: string; on: boolean }
  | { do: "value"; id: string; value: number }
  | { do: "choose"; id: string; index: number }
  /** An app command (`app.*`, workspaces and panels). */
  | { do: "app"; id: string };

/** What Build a set opens with. */
export interface SetPlan {
  minutes?: number;
  shape?: SetShape;
  vocals?: VocalPlan;
  playlist?: number | null;
  query?: string;
  /** Open with this track. */
  seed?: number | null;
}

export type Ask =
  | { kind: "control"; steps: AskStep[] }
  /** Search the library with MixIt's search language. */
  | { kind: "find"; query: string; playlist: number | null }
  /** Search by sound: tracks that fit a description. */
  | { kind: "describe"; text: string }
  /** Tracks that sound like this one. */
  | { kind: "similar"; id: number; title: string }
  /** What to play next, with the energy going this way. */
  | { kind: "next"; energy: "up" | "down" | "steady" }
  | { kind: "buildSet"; plan: SetPlan }
  /** What a control does, in plain words. */
  | { kind: "explain"; id: string }
  /** One of the command palette's own commands (by its id there). */
  | { kind: "extra"; id: string };

export interface Understood {
  ask: Ask;
  /** What MixIt will do, in plain words. */
  say: string;
}

export interface AskDeck {
  loaded: boolean;
  playing: boolean;
  /** The track's own tempo (before the tempo slider). */
  baseBpm: number;
  /** -1..1 within the range. */
  tempo: number;
  /** The tempo slider's range, as a fraction (0.08 = ±8 %). */
  tempoRange: number;
  keyShift: number;
  /** The loaded track, for "sounds like this". */
  track?: { id: number; title: string; key?: string | null } | null;
}

/** What `understand` knows about the app right now. */
export interface AskContext {
  registry: ActionSpec[];
  /** One entry per deck in use. */
  decks: AskDeck[];
  /** The deck leading the tempo, if any. */
  masterDeck?: number | null;
  /** Current mixer values (EQ in dB, fader 0..1, filter -1..1, master dB). */
  mixer?: {
    channels: { high: number; mid: number; low: number; fader: number; filter: number; trim: number }[];
    master: number;
    /** Per FX unit (decks 0..3, master 4): each slot's type index and whether it is on. */
    fx?: { type: number; on: boolean }[][];
  };
  playlists: { id: number; name: string }[];
  /** Genres in the library, to tell them apart from other words. */
  genres: string[];
  /** The track selected in the library. */
  selected?: { id: number; title: string } | null;
  /** Search by sound is available. */
  soundSearch: boolean;
}

// ─── Words ─────────────────────────────────────────────────────────────────────

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, twenty: 20,
  thirty: 30, "thirty two": 32, forty: 40, "forty five": 45, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, "a hundred": 100, "one hundred": 100, couple: 2, "a couple of": 2, "a couple": 2,
};

/** Lower case, plain spaces, number words as digits, polite openings dropped. */
export function normalise(text: string): string {
  let t = ` ${text.toLowerCase()} `
    .replace(/[’‘`]/g, "'")
    .replace(/[“”"]/g, " ")
    .replace(/[?!,;:()]+/g, " ")
    .replace(/\.(?!\d)/g, " ")
    .replace(/½/g, " and a half ")
    .replace(/−/g, "-")
    .replace(/\s+/g, " ");
  // Longest first, so "thirty two" wins over "thirty". "one" stays a word after "this" and friends.
  for (const w of Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length)) {
    const re = w === "one" ? /(?<!\b(?:this|that|the|next|another|which|other|any|new|good|same|right|selected|playing|current|last|first|little|old)) one\b/g : new RegExp(`\\b${w}\\b`, "g");
    t = t.replace(re, (m) => (m.startsWith(" ") ? " " : "") + String(NUMBER_WORDS[w]));
  }
  t = t.replace(/\b(\d+) (\d)\b/g, (m, a, b) => (Number(a) % 10 === 0 && Number(a) >= 20 ? String(Number(a) + Number(b)) : m));
  const filler =
    /^(?:hey|hi|ok|okay|so|um|mixit|yo|please|pls|can you|could you|would you|will you|can i|could i|i want to|i wanna|i'd like to|i would like to|i need to|let's|lets|let me|help me|go ahead and|just(?! the| vocals?| drums| bass| melody| instrumental)|now|quickly|maybe|try to|try and)\s+/;
  t = t.trim();
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(filler, "");
  }
  return t.replace(/\s+(?:please|pls|for me|thanks|thank you|now|right now|mixit)$/g, "").trim();
}

const has = (t: string, re: RegExp) => re.test(t);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, step = 0.01) => Math.round(v / step) * step;

function spec(ctx: AskContext, id: string): ActionSpec | undefined {
  return ctx.registry.find((a) => a.id === id);
}

function exists(ctx: AskContext, id: string): boolean {
  return ctx.registry.some((a) => a.id === id);
}

function options(ctx: AskContext, id: string): string[] {
  const k = spec(ctx, id)?.kind;
  return k?.type === "choice" ? k.options : [];
}

/** Turns a word that means on or off into a boolean (`null` when neither). */
function onOff(t: string): boolean | null {
  if (has(t, /\b(?:off|disable|disengage|deactivate|stop|no more|unset|release|leave|exit|end|cancel|without)\b|\bturn (?:it )?off\b|\bun(?:lock|sync|loop|mute)\b|\bdon't\b/)) return false;
  if (has(t, /\b(?:on|enable|engage|activate|start|use|turn on|switch on|with)\b/)) return true;
  return null;
}

// ─── Decks ─────────────────────────────────────────────────────────────────────

/** The deck a sentence names, with the words that named it taken out. */
function namedDeck(t: string, ctx: AskContext): { deck: number | null; rest: string } {
  const n = ctx.decks.length;
  const pick = (i: number, re: RegExp) => (i >= 0 && i < Math.max(n, 2) ? { deck: i, rest: t.replace(re, " ").replace(/\s+/g, " ").trim() } : null);
  let m = /\b(?:on |for |of |to |from )?(?:the )?(?:deck|player|channel|side) ?([a-d1-4])\b(?:'s)?/.exec(t);
  if (m) return pick(/\d/.test(m[1]) ? Number(m[1]) - 1 : m[1].charCodeAt(0) - 97, new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))) ?? { deck: null, rest: t };
  m = /\b(?:on |for |of |to |from |in )?(?:the )?(left|right)(?: deck| side| one| player| channel)?\b/.exec(t);
  if (m && !/\b(?:all )?(?:the way )?(?:to the )?(?:left|right)\b/.test(t.replace(m[0], "").trim() + " ") && !has(t, /crossfader|cross fader|xfader|pan/)) {
    return pick(m[1] === "left" ? 0 : 1, new RegExp(m[0]))!;
  }
  m = /\b(?:on |for |of |to |from |in )?the other (?:deck|one|side|player|track)\b/.exec(t);
  if (m) {
    const cur = currentDeck(ctx);
    return pick(cur === 0 ? 1 : 0, new RegExp(m[0]))!;
  }
  // "play b", "stop a", "sync b", "eq on b": a bare letter right after a short command or "on".
  m = /^(play|start|stop|pause|cue|sync|eject|load|loop|brake|reverse|unsync)\s+([a-d])$/.exec(t);
  if (m) return { deck: m[2].charCodeAt(0) - 97, rest: m[1] };
  m = /\b(?:on|for) ([a-d])$/.exec(t);
  if (m && m[1] !== "a") return { deck: m[1].charCodeAt(0) - 97, rest: t.slice(0, m.index).trim() };
  m = /\b(?:on|for) a$/.exec(t);
  if (m) return { deck: 0, rest: t.slice(0, m.index).trim() };
  return { deck: null, rest: t };
}

/** The deck someone most likely means when they don't say: the one playing, or while
 *  two play, the one coming in (not the tempo leader); else the first loaded. */
export function currentDeck(ctx: AskContext): number {
  const playing = ctx.decks.map((d, i) => (d.playing ? i : -1)).filter((i) => i >= 0);
  if (playing.length === 1) return playing[0];
  if (playing.length > 1) return playing.find((i) => i !== ctx.masterDeck) ?? playing[0];
  const loaded = ctx.decks.findIndex((d) => d.loaded);
  return loaded >= 0 ? loaded : 0;
}

function deckFor(verb: "start" | "stop" | "any", named: number | null, ctx: AskContext): number {
  if (named != null) return named;
  if (verb === "start") {
    const ready = ctx.decks.findIndex((d) => d.loaded && !d.playing);
    if (ready >= 0) return ready;
  }
  if (verb === "stop") {
    const playing = ctx.decks.findIndex((d) => d.playing);
    if (playing >= 0) return playing;
  }
  return currentDeck(ctx);
}

// ─── Library searches ──────────────────────────────────────────────────────────

const COMMON_GENRES = [
  "drum and bass", "drum n bass", "dnb", "d&b", "deep house", "tech house", "progressive house", "afro house", "house", "techno",
  "minimal", "trance", "psytrance", "hip hop", "hip-hop", "rap", "r&b", "rnb", "pop", "disco", "nu disco", "funk", "soul",
  "dubstep", "garage", "uk garage", "jungle", "breakbeat", "breaks", "ambient", "downtempo", "lo-fi", "lofi", "edm",
  "electro", "electronica", "reggae", "reggaeton", "dancehall", "afrobeats", "amapiano", "latin", "jazz", "rock", "trap", "grime",
  "hardstyle", "hardcore", "bass house", "future bass", "electro house", "big room", "melodic techno",
];

/** Words that describe how something sounds rather than what it is. */
const SOUND_WORDS =
  /\b(?:dark|bright|rolling|chill|chilled|dreamy|warm|cold|punchy|heavy|deep|groovy|funky|melodic|moody|uplifting|euphoric|happy|sad|aggressive|gritty|dirty|smooth|soft|hard|driving|hypnotic|atmospheric|spacey|ethereal|lush|minimal|raw|bouncy|jazzy|soulful|tribal|acid|piano|guitar|synth|strings|sax|saxophone|choir|female|male|vocal|vocals|bassline|sub|kick|percussion|percussive|tropical|sunny|summer|night|late|emotional|epic|cinematic|retro|vintage|80s|90s|organic|acoustic|electronic|industrial|glitchy|distorted|fat|big|tight|loose|breezy|jazzy)\b/;

const FIND_STOP = new Set(
  "a an the some any all my me i you it its find show search look looking for list give get got have do does which what who tracks track songs song tunes tune music records record stuff things ones one with that are is be in of and or to from on by like something anything please library collection crate playlist pull up dig out need want play put load".split(" "),
);

interface Filters {
  terms: string[];
  playlist: number | null;
  /** What's left once the filters are taken out. */
  rest: string;
}

function keyTerm(letter: string, accidental: string | undefined, mode: string | undefined): string {
  const acc = !accidental ? "" : /^(?:#|sharp)$/.test(accidental) ? "#" : "b";
  const minor = !!mode && /^(?:minor|min|m)$/.test(mode);
  return `${letter.toUpperCase()}${acc}${minor ? "m" : ""}`;
}

/** Takes the parts of a sentence MixIt's search language can say exactly out of it. */
function filters(t: string, ctx: AskContext): Filters {
  const terms: string[] = [];
  let playlist: number | null = null;
  let s = ` ${t} `;
  const take = (re: RegExp, f: (m: RegExpExecArray) => string | null | void) => {
    const m = re.exec(s);
    if (!m) return false;
    const term = f(m);
    if (term) terms.push(term);
    s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length);
    return true;
  };
  // Playlists first: their names can hold any word.
  const named = [...ctx.playlists].sort((a, b) => b.name.length - a.name.length);
  for (const p of named) {
    const n = p.name.toLowerCase().replace(/[^\w&' -]+/g, " ").replace(/\s+/g, " ").trim();
    if (!n) continue;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Only when the sentence says it's a playlist ("from …", "… playlist"): a name like
    // "Peak time" is also just words.
    const re = `\\s(?:(?:from|in|out of|off|using) (?:my |the )?${esc}(?: (?:playlist|crate|list|folder))?|(?:my |the )?${esc} (?:playlist|crate|list|folder))\\s`;
    if (take(new RegExp(re), () => null)) {
      playlist = p.id;
      break;
    }
  }
  // Tempo.
  take(/\s(?:between|from) (\d{2,3}) ?(?:bpm )?(?:and|to|-) (\d{2,3})(?: ?bpm)?\s/, (m) => `bpm:${m[1]}-${m[2]}`) ||
    take(/\s(\d{2,3}) ?(?:-|to) ?(\d{2,3}) ?bpm\s/, (m) => `bpm:${m[1]}-${m[2]}`) ||
    take(/\s(?:faster than|over|above|more than) (\d{2,3}) ?(?:bpm)?\s/, (m) => `bpm:>${m[1]}`) ||
    take(/\s(?:slower than|under|below|less than) (\d{2,3}) ?(?:bpm)?\s/, (m) => `bpm:<${m[1]}`) ||
    take(/\s(?:at |around |about |near |roughly |close to |~)?(\d{2,3}) ?bpm\s/, (m) => `bpm:~${m[1]}`) ||
    take(/\s(?:around|about|near|roughly|close to) (\d{2,3})\s/, (m) => `bpm:~${m[1]}`);
  // Key.
  take(/\s(?:in|key of|in the key of|key) ([a-g])(?: ?(#|sharp|flat|b(?= )))? ?(minor|major|min|maj|m)\s/, (m) => `key:${keyTerm(m[1], m[2], m[3])}`) ||
    take(/\s(?:in |key of |in the key of |key )([a-g])(?: ?(#|sharp|flat))?\s(?=key|$|\s*$)/, (m) => `key:${keyTerm(m[1], m[2], undefined)}`) ||
    take(/\s(?:in |key )?(1[0-2]|[1-9])([ab])\s/, (m) => `key:${m[1]}${m[2].toUpperCase()}`);
  if (/\s(?:in key|in a matching key|in a compatible key|that mix(?:es)? (?:in key|harmonically)|harmonic(?:ally)?(?: compatible| matching)?)\s/.test(s)) {
    const k = ctx.decks[currentDeck(ctx)]?.track?.key;
    take(/\s(?:in key|in a matching key|in a compatible key|that mix(?:es)? (?:in key|harmonically)|harmonic(?:ally)?(?: compatible| matching)?)(?: with (?:this|that|it|the current track|what's playing))?\s/, () => (k ? `key:~${k}` : null));
  }
  // Singing.
  take(/\s(?:no vocals?|without (?:any )?(?:vocals?|singing|voice|words|lyrics)|instrumentals?|no singing|no words)\s/, () => "vocals:no") ||
    take(/\s(?:with (?:vocals?|singing|a singer|lyrics|words)|vocal tracks?|that have vocals|with a voice)\s/, () => "vocals:yes");
  // Energy.
  take(/\s(?:energy (?:of )?(\d{1,2})(?: or more| and up|\+| or higher)?)\s/, (m) => `energy:${m[1]}+`) ||
    take(/\s(?:high[- ]energy|higher energy|big energy|peak[- ]time|bangers?|banging|full on|full power)\s/, () => "energy:7+") ||
    take(/\s(?:low[- ]energy|lower energy|calm|mellow|relaxed|laid[- ]back|gentle|quiet)\s/, () => "energy:<5");
  // Ratings, plays, when added.
  take(/\s([1-5]) stars?(?: or more| and up| or better|\+)?\s/, (m) => `rating:${m[1]}+`) ||
    take(/\s(?:favou?rites?|best rated|top rated|highest rated|my best)\s/, () => "rating:4+");
  take(/\s(?:not played|haven't played|i haven't played)(?: in| for)? (?:the last |a |an )?(\d+)? ?(day|week|month|year)s?\s/, (m) => `played:>${m[1] ?? 1}${m[2][0]}`) ||
    take(/\s(?:never played|not played yet|haven't played(?: yet)?|i haven't played(?: yet)?|unplayed|not played before)\s/, () => "played:never") ||
    take(/\s(?:played (?:recently|this week|lately)|recently played)\s/, () => "played:<7d");
  take(/\s(?:new(?:est)?|recently added|latest|fresh)(?= )/, () => "added:<2w");
  take(/\stagged (?:as )?([\w-]+)\s/, (m) => `tag:${m[1]}`);
  take(/\s(?:not analy[sz]ed|unanaly[sz]ed|need(?:s|ing)? analy[sz]ing)\s/, () => "analysed:no");
  take(/\s(?:missing|lost|not found)(?: files?)?\s/, () => "missing:yes");
  // Artist: "by Daft Punk".
  take(/\sby ((?:[\w'&.-]+ ?){1,4}?)(?=\s(?:at|around|in|with|without|from|between|that|which|over|under|bpm|and|no)\s|\s*$)/, (m) => `artist:"${m[1].trim()}"`);
  // Genres, longest first.
  const genres = [...new Set([...ctx.genres.map((g) => g.toLowerCase().trim()), ...COMMON_GENRES])].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
  for (const g of genres) {
    const esc = g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (take(new RegExp(`\\s${esc}\\s`), () => (g.includes(" ") ? `genre:"${g}"` : `genre:${g}`))) break;
  }
  return { terms, playlist, rest: s.replace(/\s+/g, " ").trim() };
}

function restWords(rest: string): string[] {
  return rest.split(" ").filter((w) => w && !FIND_STOP.has(w));
}

const FIND_START =
  /^(?:find|show|search|look for|looking for|list|give me|get me|any|got any|do i have|have i got|which|what|pull up|dig out|i need|i want|need|want|bring up|play me)\b/;
const FIND_NOUN = /\b(?:tracks?|songs?|tunes?|music|records?|bangers?|instrumentals?|stuff|vocals tracks)\b/;

function understandFind(t: string, ctx: AskContext): Understood | null {
  // "sounds like this", "more like this one": the track playing or selected.
  if (has(t, /\b(?:sounds?|sounding) like (?:this|that|it|the (?:current|selected) (?:track|one|song)|what's playing)\b|\b(?:more|others?|tracks?|songs?|something) like (?:this|that|it)(?: one| track| song)?$|\bsimilar(?: tracks?| songs?)?(?: to (?:this|that|it|the (?:selected|current|playing)))?(?: one| track| song)?$/)) {
    const playing = ctx.decks[currentDeck(ctx)]?.track;
    const pick = has(t, /selected/) ? ctx.selected ?? playing : playing ?? ctx.selected;
    if (pick) return { ask: { kind: "similar", id: pick.id, title: pick.title }, say: `Find tracks that sound like “${pick.title}”` };
    return null;
  }
  const like = /\b(?:that |which )?(?:sounds?|sounding|feels?|feeling|vibes?) like (.+)$/.exec(t);
  if (like && !/\b(?:this|that|it)\b/.test(like[1])) {
    if (ctx.soundSearch) return { ask: { kind: "describe", text: like[1] }, say: `Search by sound: “${like[1]}”` };
    const query = restWords(like[1]).join(" ");
    if (query) return { ask: { kind: "find", query, playlist: null }, say: `Search the library: ${query}` };
  }
  const f = filters(t, ctx);
  if (!has(t, FIND_START) && !has(t, FIND_NOUN) && !f.terms.some((x) => /^(?:genre|bpm|key):/.test(x))) return null;
  const words = restWords(f.rest);
  const soundy = words.filter((w) => SOUND_WORDS.test(` ${w} `));
  if (!f.terms.length && f.playlist == null && soundy.length && ctx.soundSearch) {
    const text = words.join(" ");
    return { ask: { kind: "describe", text }, say: `Search by sound: “${text}”` };
  }
  // Sound words alongside exact filters are left out (the search language can't hear).
  const text = words.filter((w) => !SOUND_WORDS.test(` ${w} `));
  if (!f.terms.length && f.playlist == null && !text.length) return null;
  const query = [...text, ...f.terms].join(" ");
  const where = f.playlist != null ? ` in “${ctx.playlists.find((p) => p.id === f.playlist)?.name}”` : "";
  return { ask: { kind: "find", query, playlist: f.playlist }, say: query ? `Search the library${where}: ${query}` : `Show the playlist${where}` };
}

// ─── What to play next ─────────────────────────────────────────────────────────

const ENERGY_UP = /\b(?:more energy|higher energy|harder|bigger|lift(?: it)?|pump it up|up the energy|step it up|build(?: it)? up|build the energy|take it up|turn it up a notch|heavier|livelier|more intense|faster)\b/;
const ENERGY_DOWN = /\b(?:less energy|lower energy|calm(?:er)?|chill(?:er)?|softer|slower|bring (?:it|the energy) down|cool (?:it )?down|take it down|wind down|mellower|gentler|lighter|relax)\b/;
const ENERGY_SAME = /\b(?:same energy|keep (?:the )?(?:energy|vibe|groove|mood)|similar energy|steady)\b/;

function understandNext(t: string): Understood | null {
  const asks =
    has(t, /\b(?:play|put on|mix in|load|go|follow(?: this| it)?(?: up)? with|come) next\b|\bnext (?:track|song|tune|one|record)\b|\bwhat (?:goes|works|fits|mixes|comes|should come)(?: well)? (?:with|after|next)\b|\b(?:suggest|recommend|pick|choose|find) (?:me )?(?:a |the |my )?(?:next|good next|track to play|song to play|tune to play)\b|\bwhat (?:should|can|could|do) i play\b|\bwhat to play\b|\bafter this(?: one| track| song)?$|\bwhat(?:'s)? (?:next|now)$/) ||
    (has(t, /^(?:something|anything|a track|a song|a tune|give me something|i need something|need something|got something|play something|find something|suggest something)\b/) && (ENERGY_UP.test(t) || ENERGY_DOWN.test(t) || ENERGY_SAME.test(t)));
  if (!asks) return null;
  const energy = ENERGY_UP.test(t) ? "up" : ENERGY_DOWN.test(t) ? "down" : "steady";
  const how = { up: ", lifting the energy", down: ", bringing the energy down", steady: ", keeping the energy" }[energy];
  return { ask: { kind: "next", energy }, say: `Show what mixes well next${how}` };
}

// ─── Plan a set ────────────────────────────────────────────────────────────────

const SHAPES: [SetShape, RegExp, string][] = [
  ["warmUp", /\b(?:warm[- ]?up|opening|opener|early(?: in the night)?|start of the night|first set|to open)\b/, "warm-up"],
  ["coolDown", /\b(?:cool[- ]?down|closing|closer|wind(?:ing)? down|end of the night|last set|to close|after ?hours|chill ?out)\b/, "cool-down"],
  ["journey", /\b(?:journey|up and down|rise and fall|story|ups and downs)\b/, "journey"],
  ["peak", /\b(?:peak(?:[- ]time)?|banging|bangers|full power|high energy|all bangers|hard)\b/, "peak time"],
  ["build", /\b(?:build(?:ing)?(?: up)?(?: to the peak)?|rising|climb(?:ing)?|getting bigger|growing|ramp(?:ing)? up)\b/, "build to the peak"],
  ["steady", /\b(?:steady|even|same energy|constant|flat|consistent)\b/, "steady"],
];

function minutesIn(t: string): number | undefined {
  let m = /\b(\d+(?:\.\d+)?) (?:hours?|hrs?|h) (?:and )?(?:a half|30(?: min(?:ute)?s?)?)\b/.exec(t);
  if (m) return Number(m[1]) * 60 + 30;
  m = /\b(?:an?|1) hour and a half\b|\b90 min/.exec(t);
  if (m) return 90;
  m = /\bhalf (?:an )?hour\b/.exec(t);
  if (m) return 30;
  m = /\b(\d+(?:\.\d+)?) ?(?:hours?|hrs?|h)\b/.exec(t);
  if (m) return Math.round(Number(m[1]) * 60);
  m = /\ban? hour\b|\bhour[- ]long\b/.exec(t);
  if (m) return 60;
  m = /\b(\d{1,3}) ?(?:min(?:ute)?s?|m)\b/.exec(t);
  if (m) return Number(m[1]);
  return undefined;
}

const SET_WORDS = /\b(?:build|plan|make|create|put together|prepare|give me|generate|get me|pick|choose|need|want|do|arrange|programme|program)\b.*\b(?:set|setlist|set list|mix|mixtape)\b|\b(?:set|setlist|set list|mixtape)\b.*\b(?:for|of|lasting) (?:\d|an? |half)|\b\d+ ?(?:min(?:ute)?s?|hours?|hrs?|h)\b.*\b(?:set|setlist|set list|mix)\b|\b(?:warm[- ]?up|peak[- ]time|closing|opening|cool[- ]?down|journey|steady)\b.*\bset\b/;

function understandSet(t: string, ctx: AskContext): Understood | null {
  const longFor = /^(?:give me|i need|i want|play me|make me|build me|get me)\b.*\b(?:\d+ ?(?:min(?:ute)?s?|hours?)|an? hour|half an hour)\b(?: and a half)? of\b/;
  if (!SET_WORDS.test(t) && !longFor.test(t)) return null;
  if (has(t, /\bset (?:the|deck|tempo|bpm|key|it|a cue|cue|loop|volume|eq|length|clock)\b|\bset (?:\w+ )?(?:to|at) -?\d/)) return null;
  // "make a mix from the queue" is Auto DJ's; "mix it", "mix now" are the mix buttons.
  if (has(t, /\bqueue\b/) || (has(t, /\bmix\b/) && !has(t, /\b(?:min|minutes?|hours?|warm|peak|closing|opening|cool|journey|playlist|crate|from my)\b/))) return null;
  const plan: SetPlan = {};
  const parts: string[] = [];
  const minutes = minutesIn(t);
  if (minutes) {
    plan.minutes = minutes;
    parts.push(minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} minutes`);
  }
  // The playlist first: its name can hold words that also name a shape ("House bangers").
  const fromList = filters(t, ctx).playlist;
  const listName = fromList != null ? ctx.playlists.find((p) => p.id === fromList)?.name.toLowerCase() : undefined;
  const plain = listName ? t.replace(listName, " ") : t;
  // "Build a set" asks for a set; it isn't the "build" shape.
  const shapeText = plain.replace(/^(?:build|make|plan|create|put together|prepare|give|generate|get|do)(?: me| us)?\b/, " ");
  for (const [shape, re, name] of SHAPES) {
    if (re.test(shapeText)) {
      plan.shape = shape;
      parts.push(name);
      break;
    }
  }
  if (has(t, /\b(?:no vocals?|instrumentals?(?: only)?|without (?:vocals?|singing|words)|no singing|to talk over|to sing over|for talking over)\b/)) {
    plan.vocals = "instrumental";
    parts.push("instrumentals only");
  } else if (has(t, /\b(?:not too many vocals|not too much singing|few(?:er)? vocals|some instrumentals|room for the vocals|let the vocals breathe|mix of vocals and instrumentals|not all vocals|break up the vocals)\b/)) {
    plan.vocals = "breathe";
    parts.push("instrumentals between the singers");
  }
  if (has(t, /\bstart(?:ing)? (?:with|from|on) (?:this|the selected|selected|my selected|that)(?: track| one| song)?\b|\bopen(?:ing)? with (?:this|the selected|that)(?: track| one| song)?\b/)) {
    const pick = ctx.selected ?? ctx.decks[currentDeck(ctx)]?.track ?? null;
    if (pick) {
      plan.seed = pick.id;
      parts.push(`opening with “${pick.title}”`);
    }
  } else if (has(t, /\bstart(?:ing)? (?:with|from) (?:what's playing|the current track|the track playing)\b/)) {
    const pick = ctx.decks[currentDeck(ctx)]?.track;
    if (pick) {
      plan.seed = pick.id;
      parts.push(`opening with “${pick.title}”`);
    }
  }
  // The rest is what to choose from: a playlist and a search.
  const stripped = shapeText
    .replace(SHAPES.map(([, re]) => re.source).join("|") ? new RegExp(SHAPES.map(([, re]) => re.source).join("|"), "g") : /$^/, " ")
    .replace(/\b\d+(?:\.\d+)? ?(?:hours?|hrs?|h|min(?:ute)?s?|m)\b|\ban? hour\b|\bhalf (?:an )?hour\b|\band a half\b/g, " ");
  const f = filters(stripped, { ...ctx, playlists: [] });
  const terms = f.terms.filter((x) => x !== "vocals:no" && x !== "vocals:yes" && !x.startsWith("energy:"));
  if (fromList != null) {
    plan.playlist = fromList;
    parts.push(`from “${ctx.playlists.find((p) => p.id === fromList)?.name}”`);
  }
  if (terms.length) {
    plan.query = terms.join(" ");
    parts.push(`choosing from ${plan.query}`);
  }
  return { ask: { kind: "buildSet", plan }, say: `Build a set${parts.length ? `: ${parts.join(", ")}` : ""}` };
}

/** Build a set's request from a plan, with its defaults for what the plan leaves out. */
export function planRequest(plan: SetPlan): BuildSetRequest {
  return { query: plan.query ?? "", playlist: plan.playlist ?? null, minutes: plan.minutes ?? 60, shape: plan.shape ?? "build", seed: plan.seed ?? null, variety: 0, vocals: plan.vocals ?? "any" };
}

// ─── Controls ──────────────────────────────────────────────────────────────────

type Band = "low" | "mid" | "high";
const BANDS: [Band, RegExp, string][] = [
  ["low", /\b(?:bass(?!line)|basses|lows?|low end|bottom(?: end)?|kicks?|sub(?:s| bass)?|low eq)\b/, "low EQ"],
  ["mid", /\b(?:mids?|middle|mid eq|midrange)\b/, "mid EQ"],
  ["high", /\b(?:highs?|treble|tops?|top end|hi-?hats?|hats|cymbals|high eq|hi eq)\b/, "high EQ"],
];

type StemName = "vocals" | "drums" | "bass" | "melody";
const STEM_WORDS: [StemName, RegExp][] = [
  ["vocals", /\b(?:vocals?|voices?|singing|singers?|acapellas?|rapping|lyrics|words)\b/],
  ["drums", /\b(?:drums?|percussion|beats?)\b/],
  ["bass", /\b(?:bass ?line|bass stem|bass)\b/],
  ["melody", /\b(?:melody|melodies|instruments?|synths?|keys|chords|music)\b/],
];
const STEM_LIST: StemName[] = ["vocals", "drums", "bass", "melody"];
const STEM_SAY: Record<StemName, string> = { vocals: "the vocals", drums: "the drums", bass: "the bass", melody: "the melody" };

const FX_WORDS: [string, RegExp][] = [
  ["Ping-pong delay", /\bping[- ]?pong\b/],
  ["Dub echo", /\bdub(?: echo| delay)?\b/],
  ["Echo", /\b(?:echo(?:es)?|delay)\b/],
  ["Reverb", /\b(?:reverb|verb|space|hall|room sound)\b/],
  ["Filter LFO", /\b(?:filter lfo|wobble|sweep(?:ing)? filter|lfo)\b/],
  ["Flanger", /\bflang(?:er|e|ing)\b/],
  ["Phaser", /\bphas(?:er|e|ing)\b/],
  ["Chorus", /\bchorus\b/],
  ["Gater", /\b(?:gater|gate effect|trance gate|chop(?:per)?)\b/],
  ["Slicer", /\bslicer\b/],
  ["Beat repeat", /\b(?:beat repeat|stutter|repeat)\b/],
  ["Bitcrusher", /\b(?:bit ?crush(?:er)?|crush(?:er)?|lo-?fi effect)\b/],
  ["Distortion", /\b(?:distortion|distort|drive|overdrive|saturation)\b/],
  ["Tape stop", /\btape ?stop\b/],
  ["Pitch delay", /\bpitch delay\b/],
  ["Ring modulator", /\bring ?mod(?:ulator)?\b/],
  ["Noise riser", /\b(?:noise riser|riser|white noise|noise sweep|uplifter)\b/],
];

/** A loop or jump length in beats ("4 beats", "2 bars", "half a beat", "1/4"). */
function beatsIn(t: string): number | null {
  let m = /\b(\d+)\/(\d+)(?: ?(?:of a )?(beats?|bars?))?\b/.exec(t);
  if (m) return (Number(m[1]) / Number(m[2])) * (m[3]?.startsWith("bar") ? 4 : 1);
  m = /\bhalf (?:a )?(beat|bar)\b/.exec(t);
  if (m) return m[1] === "bar" ? 2 : 0.5;
  m = /\b(?:a )?quarter (?:of )?(?:a )?(beat|bar)\b/.exec(t);
  if (m) return m[1] === "bar" ? 1 : 0.25;
  m = /\b(\d+(?:\.\d+)?) ?(beats?|bars?|phrases?)\b/.exec(t);
  if (m) return Number(m[1]) * (m[2].startsWith("bar") ? 4 : m[2].startsWith("phrase") ? 32 : 1);
  m = /\b(?:a|one|the|last|next|this) (beat|bar|phrase)\b/.exec(t);
  if (m) return m[1] === "bar" ? 4 : m[1] === "phrase" ? 32 : 1;
  return null;
}

function optionFor(opts: string[], beats: number): number {
  const vals = opts.map((o) => {
    const [a, b] = o.split(" ")[0].split("/");
    return b ? Number(a) / Number(b) : Number(a) * (o.includes("bar") ? 4 : 1);
  });
  let best = 0;
  for (let i = 1; i < vals.length; i++) if (Math.abs(Math.log(vals[i] / beats)) < Math.abs(Math.log(vals[best] / beats))) best = i;
  return best;
}

const beatsSay = (b: number) => (b >= 4 && b % 4 === 0 ? `${b / 4} bar${b === 4 ? "" : "s"}` : b < 1 ? `${b === 0.5 ? "half a" : `1/${Math.round(1 / b)}`} beat` : `${b} beat${b === 1 ? "" : "s"}`);

/** A level change: "a bit", "a lot", "all the way". */
function amount(t: string): "bit" | "lot" | "all" | "some" {
  if (has(t, /\ball the way|completely|fully|totally|entirely\b/)) return "all";
  if (has(t, /\b(?:a (?:little|bit|touch|tad|smidge)|slightly|little|bit|touch|tad|gently|a little bit)\b/)) return "bit";
  if (has(t, /\b(?:a lot|lots|way|much|loads|heaps|really|massively)\b/)) return "lot";
  return "some";
}

function dbIn(t: string): number | null {
  const m = /(?:^|\s)(-|minus |plus |\+)?(\d+(?:\.\d+)?) ?(?:db|decibels?)\b/.exec(t);
  if (!m) return null;
  return (m[1] && /-|minus/.test(m[1]) ? -1 : 1) * Number(m[2]);
}

function percentIn(t: string): number | null {
  const m = /\b(\d{1,3}) ?(?:%|percent|per cent)/.exec(t);
  if (m) return clamp(Number(m[1]) / 100, 0, 1);
  if (has(t, /\bhalf ?way|half volume|to half\b/)) return 0.5;
  return null;
}

const dbSay = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(round(v, 0.1))} dB`;

interface C {
  t: string;
  /** The sentence without the deck's name. */
  r: string;
  named: number | null;
  ctx: AskContext;
}

const control = (steps: AskStep[], say: string): Understood | null => (steps.length ? { ask: { kind: "control", steps }, say } : null);
const D = (d: number) => `Deck ${LETTERS[d]}`;

function transport({ r, named, ctx }: C): Understood | null {
  if (has(r, /^(?:play|start|go|resume|unpause|hit play|press play|let it play|drop it|start it|start playing|play it|start the track|play the track|play (?:the )?(?:track|song|music))$/) || has(r, /^(?:play|start)(?: it)?(?: up)?$/)) {
    const d = deckFor("start", named, ctx);
    if (ctx.decks[d]?.playing) return { ask: { kind: "control", steps: [] }, say: `${D(d)} is already playing` };
    return control([{ do: "press", id: `deck.${LETTERS[d]}.play` }], `Play ${D(d)}`);
  }
  if (has(r, /^(?:stop|pause|halt|hold|stop it|pause it|stop the (?:track|song|music)|pause the (?:track|song|music)|stop playing|hit pause|press pause)$/)) {
    const d = deckFor("stop", named, ctx);
    if (!ctx.decks[d]?.playing) return { ask: { kind: "control", steps: [] }, say: `${D(d)} isn't playing` };
    return control([{ do: "press", id: `deck.${LETTERS[d]}.play` }], `Pause ${D(d)}`);
  }
  const d = deckFor("any", named, ctx);
  const L = LETTERS[d];
  if (has(r, /\b(?:eject|unload|clear the deck|empty the deck|take the track off)\b/)) return control([{ do: "press", id: `deck.${L}.eject` }], `Eject ${D(d)}`);
  if (has(r, /\b(?:brake|power down|turntable stop|stop like a (?:turntable|record))\b/)) return control([{ do: "press", id: `deck.${L}.brake` }], `${D(d)}: brake to a stop`);
  if (has(r, /\bspin ?up|power up|start like a (?:turntable|record)\b/)) return control([{ do: "press", id: `deck.${L}.spinup` }], `${D(d)}: spin up`);
  if (has(r, /\b(?:reverse|backwards?|play it back)\b/) && !has(r, /crossfader/)) {
    const on = onOff(r);
    return control([on == null ? { do: "press", id: `deck.${L}.reverse` } : { do: "set", id: `deck.${L}.reverse`, on }], `${D(d)}: reverse ${on === false ? "off" : on ? "on" : "on or off"}`);
  }
  if (has(r, /\bslip(?: mode)?\b/)) {
    const on = onOff(r) ?? true;
    return control([{ do: "set", id: `deck.${L}.slip`, on }], `${D(d)}: slip ${on ? "on" : "off"}`);
  }
  if (has(r, /\b(?:let it (?:end|play out|finish|run out|run)|play (?:it )?(?:out|to the end)|leave the safety loop)\b/)) return control([{ do: "press", id: `deck.${L}.let_end` }], `${D(d)}: let it play to the end`);
  if (has(r, /\b(?:censor|bleep)\b/)) return control([{ do: "tap", id: `deck.${L}.censor` }], `${D(d)}: censor`);
  if (has(r, /^(?:cue|cue it(?: up)?|back to (?:the )?cue(?: point)?|go (?:back )?to (?:the )?cue(?: point)?|return to (?:the )?cue)$/)) return control([{ do: "tap", id: `deck.${L}.cue` }], `${D(d)}: back to the cue point`);
  return null;
}

function syncAndKey({ r, named, ctx }: C): Understood | null {
  const d = deckFor("any", named, ctx);
  const L = LETTERS[d];
  if (has(r, /\b(?:match (?:the )?keys?|key ?sync|in key with|harmonic(?:ally)? match|fix the key(?: clash)?|make (?:it|them) (?:in|fit the) key|same key)\b/)) return control([{ do: "press", id: `deck.${L}.key_sync` }], `${D(d)}: move the key to fit the other track`);
  if (has(r, /\bkey ?lock|master tempo|keep the (?:key|pitch)|lock the (?:key|pitch)\b/)) {
    const on = onOff(r.replace(/\bkeep\b|\block\b/g, "")) ?? !has(r, /\bunlock\b/);
    return control([{ do: "set", id: `deck.${L}.keylock`, on }], `${D(d)}: key lock ${on ? "on" : "off"}`);
  }
  if (has(r, /\b(?:un)?sync(?:ed|ing|ronise|ronize)?\b|\bbeat ?match\b|\bmatch (?:the )?(?:tempos?|bpms?|beats?|speeds?)\b|\block (?:the )?(?:tempo|beats?)\b/)) {
    const on = has(r, /\bunsync\b/) ? false : onOff(r.replace(/\bmatch\b/, "")) ?? true;
    return control([{ do: "set", id: `deck.${L}.sync`, on }], `${D(d)}: sync ${on ? "on" : "off"}`);
  }
  if (has(r, /\b(?:tempo|speed|bpm) (?:leader|master)\b|\bmake (?:it|this deck|this) (?:the )?(?:tempo )?(?:leader|master)\b|\blead the tempo\b/)) return control([{ do: "press", id: `deck.${L}.master` }], `${D(d)} leads the tempo`);
  return null;
}

function tempo({ r, named, ctx }: C): Understood | null {
  const d = deckFor("any", named, ctx);
  const L = LETTERS[d];
  const deck = ctx.decks[d];
  if (has(r, /\breset (?:the )?(?:tempo|pitch|speed|bpm)|(?:tempo|speed|pitch) (?:back )?to (?:zero|0|normal|original)|original (?:tempo|speed|bpm)|normal speed\b/)) return control([{ do: "press", id: `deck.${L}.tempo_reset` }], `${D(d)}: back to its own tempo`);
  if (has(r, /\b(?:reset|original|normal) (?:the )?key\b|\bkey (?:shift )?(?:back )?to (?:0|zero|normal|original)\b|\bundo the key shift\b/)) return control([{ do: "value", id: `deck.${L}.key_shift`, value: 0 }], `${D(d)}: back to its own key`);
  const semi = /\b(?:pitch|key|transpose|shift)(?: (?:it|the key|the pitch|key shift))? (up|down|by|to) ?(\+|-|minus |plus )?(\d+(?:\.\d+)?)? ?(?:semi-?tones?|half[- ]?steps?|steps?|keys?|notes?)?\b/.exec(r);
  if (semi && (semi[3] || semi[1] === "up" || semi[1] === "down") && !has(r, /\b(?:tempo|speed|bpm|faster|slower)\b/)) {
    const n = semi[3] ? Number(semi[3]) : 1;
    const sign = semi[1] === "down" || (semi[2] && /-|minus/.test(semi[2])) ? -1 : 1;
    const value = semi[1] === "to" ? sign * n : clamp((deck?.keyShift ?? 0) + sign * n, -12, 12);
    return control([{ do: "value", id: `deck.${L}.key_shift`, value }], `${D(d)}: key ${value > 0 ? "+" : ""}${value} semitone${Math.abs(value) === 1 ? "" : "s"}`);
  }
  const to = /\b(?:tempo|bpm|speed)(?: of [a-d])? (?:to|at|=) ?(\d{2,3}(?:\.\d+)?)|\b(?:play|run|set|put|bring)(?: it| this| the track)? (?:at|to) (\d{2,3}(?:\.\d+)?) ?(?:bpm)?\b/.exec(r);
  if (to) {
    const bpm = Number(to[1] ?? to[2]);
    if (!deck?.loaded || !deck.baseBpm) return { ask: { kind: "control", steps: [] }, say: `${D(d)} has no track with a tempo to change` };
    const want = (bpm / deck.baseBpm - 1) / deck.tempoRange;
    const value = clamp(round(want, 0.0001), -1, 1);
    const reach = deck.baseBpm * (1 + value * deck.tempoRange);
    const note = Math.abs(want) > 1 ? ` (as close as the tempo range allows: ${reach.toFixed(1)} BPM)` : "";
    return control([{ do: "value", id: `deck.${L}.tempo`, value }], `${D(d)}: tempo to ${bpm} BPM${note}`);
  }
  const faster = has(r, /\b(?:speed (?:it |this |the track )?up|faster|quicker|tempo up|more tempo|increase the (?:tempo|speed|bpm)|raise the (?:tempo|bpm))\b/);
  const slower = has(r, /\b(?:slow (?:it |this |the track )?down|slower|tempo down|decrease the (?:tempo|speed|bpm)|lower the (?:tempo|bpm)|reduce the (?:tempo|bpm))\b/);
  if ((faster || slower) && !has(r, /\bthan\b|\b(?:next|tracks?|songs?|something|tunes?|music)\b/)) {
    if (!deck) return null;
    const pct = /(\d+(?:\.\d+)?) ?(?:%|percent)/.exec(r);
    const bpmBy = /\bby (\d+(?:\.\d+)?) ?bpm\b/.exec(r);
    const step = pct ? Number(pct[1]) / 100 : bpmBy && deck.baseBpm ? Number(bpmBy[1]) / deck.baseBpm : amount(r) === "bit" ? 0.005 : amount(r) === "lot" ? 0.03 : 0.01;
    const value = clamp(round(deck.tempo + ((faster ? 1 : -1) * step) / deck.tempoRange, 0.0001), -1, 1);
    const what = pct ? `${pct[1]} %` : bpmBy ? `${bpmBy[1]} BPM` : `${round(step * 100, 0.1)} %`;
    return control([{ do: "value", id: `deck.${L}.tempo`, value }], `${D(d)}: ${faster ? "faster" : "slower"} by ${what}`);
  }
  return null;
}

function loops({ r, named, ctx }: C): Understood | null {
  if (has(r, /\bsafety loop|loop roll|loop playback\b/)) return null;
  const d = deckFor("any", named, ctx);
  const L = LETTERS[d];
  if (has(r, /\b(?:halve|half|shorten|shorter|cut) (?:the )?loop\b|\bloop (?:in half|shorter)\b|\bhalf the loop\b/)) return control([{ do: "press", id: `deck.${L}.loop.halve` }], `${D(d)}: halve the loop`);
  if (has(r, /\b(?:double|lengthen|longer|extend) (?:the )?loop\b|\bloop (?:longer|twice as long)\b|\bdouble the loop\b/)) return control([{ do: "press", id: `deck.${L}.loop.double` }], `${D(d)}: double the loop`);
  if (has(r, /\breloop|loop (?:it )?again|back into the loop\b/)) return control([{ do: "press", id: `deck.${L}.loop.reloop` }], `${D(d)}: back into the loop`);
  if (has(r, /\bloop in\b/)) return control([{ do: "press", id: `deck.${L}.loop.in` }], `${D(d)}: loop starts here`);
  if (has(r, /\bloop out\b/)) return control([{ do: "press", id: `deck.${L}.loop.out` }], `${D(d)}: loop ends here`);
  if (has(r, /\bmove (?:the )?loop (?:back|earlier)\b/)) return control([{ do: "press", id: `deck.${L}.loop.move_back` }], `${D(d)}: move the loop back`);
  if (has(r, /\bmove (?:the )?loop (?:forward|ahead|later|on)\b/)) return control([{ do: "press", id: `deck.${L}.loop.move_fwd` }], `${D(d)}: move the loop forward`);
  if (has(r, /\b(?:stop|exit|end|release|cancel|leave|turn off|get out of|break|kill|drop) (?:the )?loop(?:ing)?\b|\bunloop\b|\bloop off\b|\bno (?:more )?loop\b|\bstop looping\b/)) {
    return control([{ do: "set", id: `deck.${L}.loop.auto`, on: false }], `${D(d)}: leave the loop`);
  }
  if (has(r, /\bloop(?:ing)?\b/) && !has(r, /\broll\b/)) {
    const beats = beatsIn(r);
    const steps: AskStep[] = [];
    let say = `${D(d)}: loop`;
    if (beats != null) {
      const idx = optionFor(options(ctx, `deck.${L}.loop.size`), beats);
      steps.push({ do: "choose", id: `deck.${L}.loop.size`, index: idx });
      say += ` ${beatsSay(beats)}`;
    }
    steps.push({ do: "set", id: `deck.${L}.loop.auto`, on: true });
    return control(steps, say);
  }
  const jump = /\b(?:beat ?jump|jump|skip|move|go|step)(?: it)? (forward|forwards|ahead|on|back|backwards?|behind|earlier|later)\b|\b(?:jump|skip)\b.*\b(forward|forwards|ahead|back|backwards?)\b/.exec(r);
  if (jump) {
    const dir = /back|behind|earlier/.test(jump[1] ?? jump[2]) ? "back" : "fwd";
    const beats = beatsIn(r);
    const steps: AskStep[] = [];
    if (beats != null) steps.push({ do: "choose", id: `deck.${L}.beatjump.size`, index: optionFor(options(ctx, `deck.${L}.beatjump.size`), beats) });
    steps.push({ do: "press", id: `deck.${L}.beatjump.${dir}` });
    return control(steps, `${D(d)}: jump ${dir === "back" ? "back" : "forward"}${beats != null ? ` ${beatsSay(beats)}` : ""}`);
  }
  return null;
}

function cues({ r, named, ctx }: C): Understood | null {
  const d = deckFor("any", named, ctx);
  const L = LETTERS[d];
  const m = /\b(?:hot ?)?cue(?: point)? (?:number )?(\d{1,2})\b|\b(?:hot ?cue|cue) #?(\d{1,2})\b/.exec(r);
  if (!m) return null;
  const n = Number(m[1] ?? m[2]);
  if (!exists(ctx, `deck.${L}.hotcue.${n}`)) return null;
  if (has(r, /\b(?:delete|remove|clear|erase|forget)\b/)) return control([{ do: "press", id: `deck.${L}.hotcue.${n}.delete` }], `${D(d)}: delete hot cue ${n}`);
  const set = has(r, /\b(?:set|save|mark|add|make|drop|place|put)\b/);
  return control([{ do: "tap", id: `deck.${L}.hotcue.${n}` }], `${D(d)}: ${set ? `set hot cue ${n} here (if it's empty)` : `jump to hot cue ${n}`}`);
}

function stems({ r, named, ctx }: C): Understood | null {
  const d = deckFor("any", named, ctx);
  const L = LETTERS[d];
  const mute = (which: StemName[], on: boolean): AskStep[] => which.map((s) => ({ do: "set", id: `deck.${L}.stem.${s}.mute`, on }));
  if (has(r, /\b(?:acapella|a cappella|acappella|just (?:the )?vocals?|only (?:the )?vocals?|vocals? only)\b/)) {
    return control([...mute(["vocals"], false), ...mute(["drums", "bass", "melody"], true)], `${D(d)}: just the vocals`);
  }
  if (has(r, /\b(?:instrumental(?: version| only)?|just the (?:beat|music|instrumental)|karaoke)\b/) && !has(r, /\b(?:find|show|tracks|songs|set)\b/)) {
    return control([...mute(["vocals"], true), ...mute(["drums", "bass", "melody"], false)], `${D(d)}: the music without the vocals`);
  }
  if (has(r, /\b(?:all|every) (?:the )?stems? (?:back|on)|\bunmute (?:all|everything)\b|\bbring (?:everything|it all|all the stems) back\b|\bfull (?:track|mix) (?:back|again)\b|\b(?:reset|restore) (?:the )?stems\b/)) {
    return control(mute(STEM_LIST, false), `${D(d)}: every stem back`);
  }
  const stem = STEM_WORDS.find(([, re]) => re.test(r))?.[0];
  if (!stem) return null;
  // "Bass" alone is the EQ's job unless the sentence says mute, solo or stem.
  const stemVerb = /\bbring (?:the |my |all )?\w+ back\b|\btake (?:the |my )?\w+ (?:out|away|off)\b|\b(?:mute|unmute|silence|solo|isolate|stems?|without|no|just|only|take (?:out|away)|remove|drop|bring back|lose|get rid of|kill|cut|turn (?:off|on)|switch (?:off|on))\b/;
  if (stem === "bass" && !has(r, /\b(?:mute|unmute|solo|isolate|stems?|bass ?line|silence)\b/)) return null;
  if (!has(r, stemVerb) && !has(r, /\b(?:down|up|lower|louder|quieter|softer|level)\b/)) return null;
  if (stem === "drums" && has(r, /\bbeat\b/) && !has(r, /\b(?:drums?|percussion|mute|solo)\b/) && has(r, /\b(?:jump|grid|match|sync)\b/)) return null;
  if (has(r, /\b(?:solo|isolate|just|only)\b/)) {
    return control([...mute([stem], false), ...mute(STEM_LIST.filter((s) => s !== stem), true)], `${D(d)}: just ${STEM_SAY[stem]}`);
  }
  if (has(r, /\bbring (?:the |my )?\w+ back\b/) || has(r, /\b(?:unmute|bring (?:back|in)|restore|return|turn (?:on|back on)|switch on|add back|put back)\b|\bback in\b/)) {
    return control(mute([stem], false), `${D(d)}: bring back ${STEM_SAY[stem]}`);
  }
  if (has(r, /\btake (?:the |my )?\w+ (?:out|away|off)\b/) || has(r, /\b(?:mute|silence|without|no|take (?:out|away)|remove|drop|lose|get rid of|kill|cut|turn off|switch off)\b/)) {
    return control(mute([stem], true), `${D(d)}: mute ${STEM_SAY[stem]}`);
  }
  const level = has(r, /\b(?:up|louder|more|raise)\b/) ? 1 : amount(r) === "bit" ? 0.75 : 0.5;
  return control([{ do: "value", id: `deck.${L}.stem.${stem}`, value: level }], `${D(d)}: ${STEM_SAY[stem]} at ${Math.round(level * 100)} %`);
}

function eq({ r, named, ctx }: C): Understood | null {
  const d = deckFor("any", named, ctx);
  const L = LETTERS[d];
  const ch = ctx.mixer?.channels[d];
  if (has(r, /\b(?:reset|flatten|flat|centre|center|zero|clear) (?:the |all (?:the )?)?eqs?\b|\beqs? (?:back )?to (?:flat|zero|0|normal|centre|center)\b/)) {
    const steps: AskStep[] = BANDS.flatMap(([b]) => [
      { do: "set", id: `mixer.${L}.eq.kill.${b}`, on: false } as AskStep,
      { do: "value", id: `mixer.${L}.eq.${b}`, value: 0 } as AskStep,
    ]);
    return control(steps, `${D(d)}: EQ back to flat`);
  }
  const band = BANDS.find(([, re]) => re.test(r));
  if (!band) return null;
  const [b, , name] = band;
  if (b === "low" && has(r, /\b(?:mute|solo|stem|isolate)\b/)) return null;
  const cur = ch ? ch[b] : 0;
  const id = `mixer.${L}.eq.${b}`;
  const db = dbIn(r);
  if (db != null) {
    const by = /\b(?:up|boost|raise|more)\b/.test(r) ? 1 : /\b(?:down|lower|cut|less|reduce)\b/.test(r) && !/(?:^|\s)-|minus/.test(r) ? -1 : 0;
    const value = clamp(by ? cur + by * Math.abs(db) : db, -26, 6);
    return control([{ do: "set", id: `mixer.${L}.eq.kill.${b}`, on: false }, { do: "value", id, value }], `${D(d)}: ${name} to ${dbSay(value)}`);
  }
  if (has(r, /\b(?:unkill|bring (?:back|in)|restore|return|put back|back in|reset|flat|normal|centre|center|zero)\b/)) {
    return control([{ do: "set", id: `mixer.${L}.eq.kill.${b}`, on: false }, { do: "value", id, value: 0 }], `${D(d)}: ${name} back to normal`);
  }
  if (has(r, /\bkill\b/)) return control([{ do: "set", id: `mixer.${L}.eq.kill.${b}`, on: true }], `${D(d)}: kill the ${name.replace(" EQ", "s").replace("lows", "lows").replace("mids", "mids")}`);
  if (has(r, /\b(?:cut|remove|take (?:out|away|off)|drop|lose|get rid of|no|without|swap|all the way down)\b/) && !has(r, /\b(?:cut (?:it )?down|a (?:bit|little)|slightly)\b/)) {
    return control([{ do: "value", id, value: -26 }], `${D(d)}: ${name} all the way down`);
  }
  const how = amount(r);
  if (has(r, /\b(?:down|lower|less|reduce|decrease|quieter|softer|cut (?:it )?down|tame|turn down|back off|ease)\b/)) {
    const value = clamp(how === "all" ? -26 : cur - (how === "bit" ? 3 : how === "lot" ? 12 : 6), -26, 6);
    return control([{ do: "value", id, value }], `${D(d)}: ${name} down to ${dbSay(value)}`);
  }
  if (has(r, /\b(?:up|more|boost|raise|increase|louder|add|turn up|lift|pump)\b/)) {
    const value = clamp(how === "all" ? 6 : cur + (how === "bit" ? 2 : how === "lot" ? 6 : 3), -26, 6);
    return control([{ do: "set", id: `mixer.${L}.eq.kill.${b}`, on: false }, { do: "value", id, value }], `${D(d)}: ${name} up to ${dbSay(value)}`);
  }
  return null;
}

function filter({ r, named, ctx }: C): Understood | null {
  if (!has(r, /\bfilter(?:ed|ing)?\b|\b(?:high|low)[- ]?pass\b|\b(?:hpf|lpf)\b|\bmuffle|underwater\b/) || has(r, /\blfo|wobble|resonance\b/)) return null;
  const d = deckFor("any", named, ctx);
  const L = LETTERS[d];
  const id = `mixer.${L}.filter`;
  if (has(r, /\b(?:reset|remove|clear|off|no|centre|center|zero|open|undo|take off|get rid of)\b/) && !has(r, /\bturn (?:it )?up|down\b/)) return control([{ do: "value", id, value: 0 }], `${D(d)}: filter off`);
  const how = amount(r);
  const depth = how === "all" ? 1 : how === "bit" ? 0.3 : how === "lot" ? 0.85 : 0.6;
  if (has(r, /\b(?:high[- ]?pass|hpf|thin|up|brighter|take out the bass|from below)\b/)) return control([{ do: "value", id, value: depth }], `${D(d)}: filter the bass out (${Math.round(depth * 100)} %)`);
  if (has(r, /\b(?:low[- ]?pass|lpf|down|darker|muffle|muffled|underwater|close|dull)\b/) || has(r, /\bfilter (?:it|this|the track)?$/)) {
    return control([{ do: "value", id, value: -depth }], `${D(d)}: filter the highs out (${Math.round(depth * 100)} %)`);
  }
  return null;
}

function volume({ r, named, ctx }: C): Understood | null {
  const master = has(r, /\b(?:master|overall|everything|the whole (?:mix|thing)|main (?:volume|output)|output|speakers)\b/);
  const vol = has(r, /\b(?:volume|loud(?:er)?|quiet(?:er)?|softer|level|fader|turn (?:\w+ )?(?:up|down)|fade(?: it)? (?:in|out|up|down)|bring (?:it |deck [a-d] |this )?(?:in|up|down|out)|silence|mute)\b/);
  if (!vol && !(master && has(r, /\b(?:up|down|louder|quieter|\d+ ?db)\b/))) return null;
  if (has(r, /\b(?:headphones?|cans|cue mix|booth|sampler|mic|microphone|pads?)\b/)) return null;
  if (master) {
    const cur = ctx.mixer?.master ?? 0;
    const db = dbIn(r);
    const how = amount(r);
    const up = has(r, /\b(?:up|louder|raise|increase|more)\b/);
    const down = has(r, /\b(?:down|quieter|softer|lower|decrease|less)\b/);
    if (db != null) {
      // "Down 3 dB" moves it by 3 dB; "to -3 dB" sets it.
      const value = clamp(up || down ? cur + (down ? -Math.abs(db) : Math.abs(db)) : db, -40, 6);
      return control([{ do: "value", id: "mixer.master", value }], `Master volume to ${dbSay(value)}`);
    }
    if (!up && !down) return null;
    const step = how === "bit" ? 1.5 : how === "lot" ? 6 : 3;
    const value = clamp(round(cur + (up ? step : -step), 0.5), -40, 6);
    return control([{ do: "value", id: "mixer.master", value }], `Master volume ${up ? "up" : "down"} to ${dbSay(value)}`);
  }
  const d = deckFor("any", named, ctx);
  const L = LETTERS[d];
  const id = `mixer.${L}.fader`;
  const cur = ctx.mixer?.channels[d]?.fader ?? 1;
  const pct = percentIn(r);
  if (pct != null) return control([{ do: "value", id, value: pct }], `${D(d)}: volume to ${Math.round(pct * 100)} %`);
  if (has(r, /\b(?:fade (?:it |this )?out|bring (?:it |this )?(?:down and )?out|mute|silence|kill the volume|volume (?:to )?(?:zero|0|off)|all the way down)\b/)) return control([{ do: "value", id, value: 0 }], `${D(d)}: volume all the way down`);
  if (has(r, /\b(?:fade (?:it |this )?in|bring (?:it |this )?in|full volume|volume (?:all the way )?up full|all the way up|bring (?:it |this )?up)\b/)) return control([{ do: "value", id, value: 1 }], `${D(d)}: volume all the way up`);
  const how = amount(r);
  const step = how === "bit" ? 0.1 : how === "lot" ? 0.4 : 0.2;
  if (has(r, /\b(?:up|louder|raise|increase|more)\b/)) {
    const value = clamp(round(cur + step), 0, 1);
    return control([{ do: "value", id, value }], `${D(d)}: volume up to ${Math.round(value * 100)} %`);
  }
  if (has(r, /\b(?:down|quieter|softer|lower|decrease|less)\b/)) {
    const value = clamp(round(cur - step), 0, 1);
    return control([{ do: "value", id, value }], `${D(d)}: volume down to ${Math.round(value * 100)} %`);
  }
  return null;
}

function crossfader({ r, t, ctx }: C): Understood | null {
  const xf = has(t, /\b(?:cross ?fader|cross-fader|xfader|x-fader|fader in the middle)\b/);
  const over = /\b(?:fade|move|go|switch|cross|slide|swing|mix)(?: it| everything| the mix)? (?:over |across )?to (?:deck )?([a-d]|left|right|the (?:left|right))\b/.exec(t);
  if (!xf && !over) return null;
  const side = (s: string) => (/\b(?:left|a)\b/.test(s) ? -1 : /\b(?:right|b)\b/.test(s) ? 1 : 0);
  let value: number | null = null;
  if (over) value = side(over[1]);
  else if (has(r, /\b(?:middle|centre|center|half ?way|both|even)\b/)) value = 0;
  else if (has(t, /\b(?:left|deck a|side a|to a|the a side)\b/)) value = -1;
  else if (has(t, /\b(?:right|deck b|side b|to b|the b side)\b/)) value = 1;
  if (value == null) return null;
  if (over && ctx.decks.length > 2 && /[cd]/.test(over[1])) return null;
  return control([{ do: "value", id: "mixer.crossfader", value }], `Crossfader ${value === 0 ? "to the middle" : value < 0 ? "all the way to deck A" : "all the way to deck B"}`);
}

function effects({ r, named, t, ctx }: C): Understood | null {
  const fx = FX_WORDS.find(([, re]) => re.test(r));
  const generic = has(r, /\b(?:effects?|fx)\b/);
  if (!fx && !generic) return null;
  if (fx && fx[0] === "Reverb" && has(r, /\bspace\b/) && !has(r, /\b(?:add|put|some|reverb|effect|fx|more|turn on)\b/)) return null;
  const unit = has(t, /\b(?:master|everything|the whole (?:mix|thing)|all decks|the mix)\b/) ? 4 : deckFor("any", named, ctx);
  const u = unit === 4 ? "master" : LETTERS[unit];
  const where = unit === 4 ? "Master" : D(unit);
  const slots = ctx.mixer?.fx?.[unit];
  const types = options(ctx, `fx.${u}.1.type`);
  if (has(r, /\b(?:off|stop|remove|kill|no more|clear|turn off|switch off|disable|get rid of|take off|enough|without)\b/)) {
    const want = fx ? types.indexOf(fx[0]) : -1;
    const which = [1, 2, 3].filter((s) => (want < 0 ? true : slots ? slots[s - 1]?.type === want : true));
    return control(which.map((s) => ({ do: "set", id: `fx.${u}.${s}.on`, on: false })), `${where}: ${fx ? `${fx[0].toLowerCase()} off` : "effects off"}`);
  }
  if (!fx) return null;
  const idx = types.indexOf(fx[0]);
  if (idx < 0) return null;
  // The slot already holding this effect, else the first one that's off, else slot 1.
  const slot = (slots && (slots.findIndex((s) => s.type === idx) + 1 || slots.findIndex((s) => !s.on) + 1)) || 1;
  const how = amount(r);
  const pct = percentIn(r);
  const mix = pct ?? (how === "bit" ? 0.25 : how === "lot" || how === "all" ? 0.8 : 0.5);
  const steps: AskStep[] = [
    { do: "choose", id: `fx.${u}.${slot}.type`, index: idx },
    { do: "value", id: `fx.${u}.${slot}.mix`, value: mix },
    { do: "set", id: `fx.${u}.${slot}.on`, on: true },
  ];
  const beats = beatsIn(r);
  if (beats != null && exists(ctx, `fx.${u}.${slot}.beats`)) steps.splice(1, 0, { do: "choose", id: `fx.${u}.${slot}.beats`, index: optionFor(options(ctx, `fx.${u}.${slot}.beats`), beats) });
  return control(steps, `${where}: ${fx[0].toLowerCase()} on at ${Math.round(mix * 100)} %${beats != null ? `, ${beatsSay(beats)}` : ""}`);
}

function micAndRecording({ r, t }: C): Understood | null {
  if (has(t, /\btalk ?-?over|duck (?:the music )?(?:when|while) i talk|lower the music when i (?:talk|speak)\b/)) {
    const on = onOff(t.replace(/\btalk ?-?over\b/, "")) ?? true;
    return control([{ do: "set", id: "mic.talkover", on }], `Talk-over ${on ? "on: the music dips when you speak" : "off"}`);
  }
  if (has(t, /\b(?:record|recording) (?:the |my )?mic\b|\brecord (?:my )?voice\b/)) {
    const on = onOff(t.replace(/\brecord(?:ing)?\b/, "")) ?? true;
    return control([{ do: "set", id: "mic.record", on }], `${on ? "Start" : "Stop"} recording the mic`);
  }
  if (has(t, /\b(?:mic|microphone|on air)\b/)) {
    const on = has(t, /\b(?:mute|off|turn off|switch off|disable|stop|close)\b/) ? false : has(t, /\bon air|on|unmute|turn on|switch on|open|enable|start|live|talk|speak\b/) ? true : null;
    if (on == null) return null;
    return control([{ do: "set", id: "mic.on_air", on }], `Mic ${on ? "on" : "off"}`);
  }
  if (has(r, /\b(?:record|recording)\b/)) {
    const on = has(r, /\b(?:stop|end|finish|off|pause)\b/) ? false : true;
    return control([{ do: "set", id: "global.record", on }], on ? "Start recording the mix" : "Stop recording");
  }
  return null;
}

function sampler({ r, ctx }: C): Understood | null {
  if (has(r, /\b(?:stop|silence|kill|cut) (?:all )?(?:the )?(?:pads|samples|sampler|sounds)\b/)) return control([{ do: "press", id: "sampler.stop_all" }], "Stop every pad");
  const m = /\b(?:sampler |sample )?pad (\d{1,2})\b|\bsample (\d{1,2})\b/.exec(r);
  if (!m) return null;
  const n = Number(m[1] ?? m[2]);
  if (!exists(ctx, `sampler.pad.${n}`)) return null;
  return control([{ do: "tap", id: `sampler.pad.${n}` }], `Play pad ${n}`);
}

function snap({ r }: C): Understood | null {
  if (!has(r, /\b(?:snap(?: to (?:the )?beat)?|quanti[sz]e)\b/)) return null;
  const on = onOff(r.replace(/\bto\b/, "")) ?? true;
  return control([{ do: "set", id: "global.quantize", on }], `Snap to beat ${on ? "on" : "off"}`);
}

const WORKSPACES: [string, RegExp][] = [
  ["library", /\blibrary|my (?:music|tracks|collection)|browser|crates\b/],
  ["arrange", /\barrange(?:r| view| screen)?|timeline\b/],
  ["edit", /\b(?:edit(?:or)?(?: view| screen)?|track editor)\b/],
  ["decks", /\bdecks? (?:view|screen)|big decks\b/],
  ["mix", /\bmix(?: view| screen)?|mixer\b/],
];

const PANELS: [string, RegExp, string][] = [
  ["app.sampler", /\bsampler(?: pads)?|pads\b/, "the sampler pads"],
  ["app.sequencer", /\b(?:step )?sequencer|drum machine\b/, "the step sequencer"],
  ["app.guide", /\bguide|lessons?|tutorials?|practice(?: labs)?|labs?\b/, "the guide"],
  ["app.autodj", /\bauto ?-?dj\b/, "Auto DJ"],
  ["app.coach", /\bcoach(?:ing)?|tips\b/, "the coach"],
  ["app.assistant", /\b(?:mix )?assistant\b/, "the mix assistant"],
  ["app.tools", /\btools? ?panel|tools\b/, "the tools panel"],
];

function appCommands({ t }: C): Understood | null {
  if (has(t, /\b(?:stop|silence|kill) (?:all )?(?:the )?(?:pads|samples|sounds)\b/)) return null;
  if (has(t, /^(?:undo|undo (?:that|it|the last (?:thing|change))|take that back|go back a step)$/)) return control([{ do: "app", id: "app.undo" }], "Undo");
  if (has(t, /^(?:redo|redo (?:that|it))$/)) return control([{ do: "app", id: "app.redo" }], "Redo");
  if (has(t, /\b(?:settings|preferences|options)\b/) && has(t, /\b(?:open|show|go to|change|settings|preferences)\b/)) return control([{ do: "app", id: "app.settings" }], "Open Settings");
  if (has(t, /\b(?:tour|show me around|how does (?:this|mixit) work)\b/)) return control([{ do: "app", id: "app.tour" }], "Take the 2-minute tour");
  if (has(t, /\b(?:easy|simple|beginner) (?:view|mode)\b|\b(?:pro|advanced|expert|full) (?:view|mode)\b/)) {
    const pro = has(t, /\b(?:pro|advanced|expert|full)\b/);
    return control([{ do: "app", id: pro ? "app.view.pro" : "app.view.easy" }], pro ? "Switch to the Pro view" : "Switch to the Easy view");
  }
  if (has(t, /\bexplain mode\b/)) return control([{ do: "app", id: "app.explain" }], "Explain mode");
  if (has(t, /\bsave (?:the |my )?(?:mix |project|mix project|arrangement)\b|^save$/)) return control([{ do: "app", id: "app.save" }], "Save the mix project");
  if (has(t, /\b(?:feedback|how did i do|review (?:my|the) mix|mix report)\b/)) return control([{ do: "app", id: "app.feedback" }], "Show feedback on the mix");
  const ws = /^(?:go to|open|show(?: me)?|switch to|take me to|back to|view|go back to)? ?(?:the |my )?(library|my music|my tracks|collection|mix|mixer|arrange|arranger|timeline|edit|editor|track editor|decks?)(?: view| screen| page| tab)?$/.exec(t);
  if (ws && (ws[0] !== ws[1] || has(t, /\b(?:view|screen|page|tab)$/))) {
    for (const [ws2, re] of WORKSPACES) if (re.test(ws[1] + (/^decks?$/.test(ws[1]) ? " view" : ""))) return control([{ do: "app", id: `app.workspace.${ws2}` }], `Go to ${ws2[0].toUpperCase()}${ws2.slice(1)}`);
  }
  if (has(t, /^(?:open|show|close|hide|toggle|start|stop|turn (?:on|off)|switch (?:on|off)|bring up)\b/)) {
    for (const [id, re, name] of PANELS) {
      if (!re.test(t)) continue;
      const on = !has(t, /^(?:close|hide|stop|turn off|switch off)\b/);
      return control([{ do: "app", id: on ? `${id}:on` : `${id}:off` }], `${on ? "Open" : "Close"} ${name}`);
    }
  }
  return null;
}

/** The palette's own commands. */
function extras({ t }: C): Understood | null {
  const x = (id: string, say: string): Understood => ({ ask: { kind: "extra", id }, say });
  if (has(t, /\banaly[sz]e\b/)) return x("x.analyse", "Analyse new tracks");
  if (has(t, /\b(?:tidy|clean up|fix|tidy up)\b.*\b(?:names?|titles?|tags?|details|artists?|track info)\b/)) return x("x.tidy", "Tidy track details");
  if (has(t, /^(?:add|import|scan)\b.*\b(?:folder|music|tracks|songs)\b/) && !has(t, /\bfrom (?:rekordbox|serato|traktor|virtual ?dj)\b/)) return x("x.add", "Add a music folder");
  if (has(t, /\brescan\b/)) return x("x.rescan", "Rescan music folders");
  if (has(t, /\b(?:render|export|bounce)\b.*\bstems?\b/)) return x("x.stems", "Export stems");
  if (has(t, /\b(?:render|export|bounce)\b.*\b(?:mix|file|wav|mp3|flac|project)\b/)) return x("x.render", "Render the mix to a file");
  if (has(t, /\b(?:copy|get|show)\b.*\btrack ?list\b/)) return x("x.tracklist", "Copy this session's tracklist");
  if (has(t, /\bautomix\b|\bmake (?:me )?a mix (?:from|out of|with) (?:these|tracks|the selected)\b/)) return x("x.automix", "Automix: make a mix from tracks");
  if (has(t, /\bcollection at a glance|library stats|stats|insights|how many tracks\b/)) return x("x.insights", "Collection at a glance");
  if (has(t, /\bmix it\b|\bmix (?:them|these|the next track) in\b|\bdo the transition|\bmix to the next\b/)) return control([{ do: "app", id: "app.mix_it" }], "Mix it: blend into the next track");
  return null;
}

// ─── Explain ───────────────────────────────────────────────────────────────────

function understandExplain(t: string, ctx: AskContext): Understood | null {
  const m = /^(?:what(?:'s| is| does| do)|whats|explain|tell me about|how (?:do|does|can|should)(?: i)?(?: use)?|what are|what's the point of|why (?:would|do) i use|help with)\s+(?:the |a |an )?(.+?)(?: do| for| mean| work| does)?$/.exec(t);
  if (!m) return null;
  const subject = m[1].replace(/\b(?:button|knob|control|switch|setting|thing|do|for)\b/g, "").trim();
  if (!subject || /\b(?:play next|i play|to play|next)\b/.test(subject)) return null;
  const hit = bestLabel(subject, ctx, true);
  if (!hit) return null;
  return { ask: { kind: "explain", id: hit.id }, say: `What “${hit.label}” does` };
}

// ─── Any control by its name ───────────────────────────────────────────────────

const LABEL_STOP = new Set("the a an to of on off and or in at it this that my is be with deck mixer fx set turn switch press hit toggle put make".split(" "));

function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9/+ -]+/g, " ").split(/[\s-]+/).filter((w) => w && !LABEL_STOP.has(w));
}

/** The control whose name the sentence holds most completely. */
function bestLabel(text: string, ctx: AskContext, loose = false, deck: number | null = null): ActionSpec | null {
  const got = new Set(words(text));
  let best: ActionSpec | null = null;
  let bestScore = 0;
  const n = Math.max(ctx.decks.length, 1);
  for (const a of ctx.registry) {
    const dm = /^(?:deck|mixer|fx)\.([A-D])\./.exec(a.id);
    if (dm) {
      const i = dm[1].charCodeAt(0) - 65;
      if (i >= n) continue;
      if ((deck ?? currentDeck(ctx)) !== i) continue;
    }
    const lw = words(a.label).filter((w) => !(loose && /^\d+$/.test(w)));
    if (!lw.length) continue;
    const hits = lw.filter((w) => got.has(w) || got.has(w.replace(/s$/, "")) || got.has(`${w}s`)).length;
    const all = hits === lw.length;
    if (!all && !(loose && hits / lw.length >= 0.5 && hits > 0)) continue;
    // How much of the name the sentence holds, and how much of the sentence the name explains.
    const covered = words(text).filter((w) => lw.some((l) => l === w || l === `${w}s` || `${l}s` === w)).length / Math.max(got.size, 1);
    const score = hits / lw.length + hits * 0.1 - (all ? 0 : 0.2) + (loose ? covered : 0);
    if (score > bestScore) {
      best = a;
      bestScore = score;
    }
  }
  return best;
}

function byName({ t, r, named, ctx }: C): Understood | null {
  const d = deckFor("any", named, ctx);
  const a = bestLabel(r, ctx, false, d);
  if (!a) return null;
  const where = /^(?:deck|mixer|fx)\.[A-D]\./.test(a.id) ? `${D(d)}: ` : "";
  switch (a.kind.type) {
    case "trigger":
      return a.id.startsWith("app.") ? control([{ do: "app", id: a.id }], a.label) : control([{ do: "press", id: a.id }], `${where}${a.label}`);
    case "momentary":
      return control([{ do: "tap", id: a.id }], `${where}${a.label}`);
    case "toggle": {
      const on = onOff(t);
      if (a.id.startsWith("app.")) return control([{ do: "app", id: on === false ? `${a.id}:off` : on ? `${a.id}:on` : a.id }], `${a.label}${on == null ? "" : on ? " on" : " off"}`);
      return control([on == null ? { do: "press", id: a.id } : { do: "set", id: a.id, on }], `${where}${a.label} ${on == null ? "on or off" : on ? "on" : "off"}`);
    }
    case "choice": {
      const opts = a.kind.options;
      const i = opts.map((o, k) => [o.toLowerCase().replace(/^±/, ""), k] as const).sort((x, y) => y[0].length - x[0].length).find(([o]) => new RegExp(`(?:^|\\s)${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(t))?.[1];
      if (i == null) return null;
      return control([{ do: "choose", id: a.id, index: i }], `${where}${a.label}: ${opts[i]}`);
    }
    case "continuous": {
      const s = a.kind.spec;
      const pct = percentIn(t);
      const db = dbIn(t);
      const num = /(?:to|at|=)\s*(-?\d+(?:\.\d+)?)\b/.exec(t);
      let value: number | null = null;
      if (db != null && s.unit === "Decibels") value = db;
      else if (pct != null) value = s.min + (s.max - s.min) * pct;
      else if (num) value = Number(num[1]);
      else if (has(t, /\b(?:reset|default|normal|centre|center)\b/)) value = s.default;
      else if (has(t, /\b(?:max|maximum|full|all the way up)\b/)) value = s.max;
      else if (has(t, /\b(?:min|minimum|all the way down)\b/)) value = s.min;
      if (value == null) return null;
      value = clamp(value, s.min, s.max);
      return control([{ do: "value", id: a.id, value }], `${where}${a.label} to ${s.unit === "Decibels" ? dbSay(value) : round(value, 0.01)}`);
    }
  }
}

// ─── Putting it together ───────────────────────────────────────────────────────

const RULES = [transport, cues, loops, syncAndKey, tempo, stems, eq, filter, crossfader, effects, volume, micAndRecording, sampler, snap];

/** What a typed sentence asks for, or `null` when MixIt can't tell. */
export function understand(text: string, ctx: AskContext): Understood | null {
  const t = normalise(text);
  if (t.length < 2) return null;
  const next = understandNext(t);
  if (next) return next;
  const set = understandSet(t, ctx);
  if (set) return set;
  const explain = understandExplain(t, ctx);
  if (explain) return explain;
  const { deck: named, rest } = namedDeck(t, ctx);
  const c: C = { t, r: rest, named, ctx };
  // The app's own commands, then searches when the sentence is plainly about tracks.
  const app = appCommands(c) ?? extras(c);
  if (app) return app;
  const controlWords = /^(?:stop|pause|play|start|mute|unmute|fade|bring|turn|cut|kill|drop|remove|loop|add|put|record|eject|sync|boost|lower|raise)\b|\b(?:deck|mute|unmute|loop|eq|cue|volume|fade|filter|effects?|fx|sync|key ?lock|crossfader)\b/;
  const looksLikeFind = (has(t, FIND_START) || has(t, FIND_NOUN) || filters(t, ctx).terms.some((x) => /^(?:genre|bpm|key):/.test(x))) && !has(t, controlWords);
  if (looksLikeFind) {
    const f = understandFind(t, ctx);
    if (f) return f;
  }
  for (const rule of RULES) {
    const u = rule(c);
    if (u) return u;
  }
  return understandFind(t, ctx) ?? byName(c);
}
