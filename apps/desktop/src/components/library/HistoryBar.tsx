// Above the history: which set this is (this session or a night you played before), how
// long it ran, and keeping it: as a playlist to play again, or as a tracklist to share.
import { ClipboardCopy, ListPlus } from "lucide-react";
import { clock, plural } from "../../lib/format";
import { setLabel, setSeconds } from "../../lib/history";
import { useLibrary } from "../../store/library";
import { copySetTracklist, refreshRows, saveSetAsPlaylist } from "./data";

export function HistoryBar() {
  const source = useLibrary((s) => s.source);
  const sessions = useLibrary((s) => s.sessions);
  const current = useLibrary((s) => s.currentSession);
  const entries = useLibrary((s) => s.historyEntries);
  const rows = useLibrary((s) => s.rows);
  if (source.type !== "history") return null;
  const id = source.session ?? current ?? undefined;
  const info = sessions.find((s) => s.id === id);
  const isNow = id == null || id === current;
  const label = isNow ? "This session" : info ? setLabel(info) : "A past set";
  const byId = new Map(rows.map((r) => [r.id, r.duration]));
  const secs = setSeconds(entries, (tid) => (tid != null ? byId.get(tid) : undefined));
  const started = entries[0] ? new Date(entries[0].played_at * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : null;
  const name = isNow ? `Set ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : label;
  const pick = (v: string) => {
    useLibrary.getState().set({ source: v === "now" ? { type: "history" } : { type: "history", session: Number(v) }, selected: [] });
    refreshRows();
  };
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/[0.06] px-3 py-2 text-[11px]" data-testid="history-bar">
      <select value={isNow ? "now" : String(id)} onChange={(e) => pick(e.target.value)} className="input h-7 w-44 text-[12px]" aria-label="Which set">
        <option value="now">This session</option>
        {sessions
          .filter((s) => s.id !== current)
          .map((s) => (
            <option key={s.id} value={s.id}>
              {setLabel(s)} · {s.tracks}
            </option>
          ))}
      </select>
      <span className="text-zinc-400" data-testid="history-summary">
        {entries.length === 0
          ? isNow
            ? "Nothing played yet this session. Tracks you play show up here."
            : "Nothing in this set."
          : `${plural(entries.length, "track")} · ${clock(secs)} · from ${started}${isNow ? ", newest first" : ""}`}
      </span>
      {entries.length > 0 && (
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => void saveSetAsPlaylist(isNow ? undefined : id, name)} className="flex h-6 items-center gap-1 rounded-md border border-white/[0.08] px-2 text-zinc-300 hover:text-zinc-50" title="Make a playlist of these tracks in the order you played them, to play the set again or build on it">
            <ListPlus size={11} /> Save as playlist
          </button>
          <button type="button" onClick={() => void copySetTracklist(isNow ? undefined : id)} className="flex h-6 items-center gap-1 rounded-md border border-white/[0.08] px-2 text-zinc-300 hover:text-zinc-50" title="Copy the list of tracks with the time each one started">
            <ClipboardCopy size={11} /> Copy tracklist
          </button>
        </div>
      )}
    </div>
  );
}
