import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { decodeWaveform, type Backend, type Unlisten } from "./index";
import type * as T from "./types";

function sub<P>(event: string, cb: (p: P) => void): Unlisten {
  let un: (() => void) | null = null;
  let dead = false;
  listen<P>(event, (e) => cb(e.payload)).then((u) => {
    if (dead) u();
    else un = u;
  });
  return () => {
    dead = true;
    un?.();
  };
}

export class TauriBackend implements Backend {
  readonly kind = "tauri" as const;

  appInfo() { return invoke<T.AppInfo>("app_info"); }
  action(id: string, input: T.ActionInput) { return invoke<void>("action", { id, input }); }

  loadTrack(deck: number, trackId: number) { return invoke<T.DeckInfo>("load_track", { deck, trackId }); }
  seek(deck: number, seconds: number) { return invoke<void>("seek", { deck, seconds }); }
  scratch(deck: number, phase: "start" | "move" | "end", velocity: number) { return invoke<void>("scratch", { deck, phase, velocity }); }
  setHotCue(deck: number, slot: number, seconds: number, loopSeconds?: number | null, color?: number, label?: string) {
    return invoke<void>("set_hot_cue", { deck, slot, seconds, loopSeconds: loopSeconds ?? null, color: color ?? null, label: label ?? null });
  }
  setMemoryCue(deck: number, seconds: number, label: string, color?: number | null) { return invoke<void>("set_memory_cue", { deck, seconds, label, color: color ?? null }); }
  deleteMemoryCue(deck: number, seconds: number) { return invoke<void>("delete_memory_cue", { deck, seconds }); }
  setGrid(deck: number, edit: T.GridEdit) { return invoke<void>("grid_set", { deck, edit }); }
  deleteHotCue(deck: number, slot: number) { return invoke<void>("delete_hot_cue", { deck, slot }); }
  setMainCue(deck: number, seconds: number) { return invoke<void>("set_main_cue", { deck, seconds }); }
  setLoop(deck: number, start: number, end: number, active: boolean) { return invoke<void>("set_loop", { deck, start, end, active }); }
  async waveform(trackId: number) {
    const buf = await invoke<ArrayBuffer>("waveform", { trackId });
    return decodeWaveform(buf instanceof ArrayBuffer ? buf : new Uint8Array(buf as unknown as number[]).buffer);
  }

  search(query: string, limit?: number) { return invoke<T.TrackRow[]>("library_search", { query, limit: limit ?? null }); }
  stats() { return invoke<T.LibraryStats>("library_stats"); }
  folders() { return invoke<string[]>("library_folders"); }
  removeFolder(path: string) { return invoke<void>("library_remove_folder", { path }); }
  addToLibrary(paths: string[]) { return invoke<void>("library_add", { paths }); }
  rescan() { return invoke<void>("library_rescan"); }
  analyzePending() { return invoke<void>("library_analyze"); }
  cancelJob() { return invoke<void>("job_cancel"); }
  trackDetail(id: number) { return invoke<T.TrackDetail>("track_detail", { id }); }
  editTrack(id: number, edit: T.TrackEdit) { return invoke<T.TrackRow>("track_edit", { id, edit }); }
  removeTracks(ids: number[]) { return invoke<void>("tracks_remove", { ids }); }
  editTracks(ids: number[], edit: T.TrackEdit) { return invoke<void>("tracks_edit", { ids, edit }); }
  writeTags(ids: number[], notation: "camelot" | "openKey" | "standard") { return invoke<T.WriteTagsResult>("library_write_tags", { ids, notation }); }
  writeSerato(ids: number[]) { return invoke<T.WriteTagsResult>("library_write_serato", { ids }); }
  backups() { return invoke<T.BackupInfo[]>("library_backups"); }
  backupLibrary(path?: string | null) { return invoke<string>("library_backup", { path: path ?? null }); }
  restoreLibrary(path: string) { return invoke<string>("library_restore", { path }); }
  listTags() { return invoke<T.TagDto[]>("tags_list"); }
  tagsOf(ids: number[]) { return invoke<[number, string[]][]>("tags_of", { ids }); }
  setTag(ids: number[], name: string, on: boolean, category = "") { return invoke<void>("tags_set", { ids, name, category, on }); }
  renameTag(id: number, name: string) { return invoke<number>("tag_rename", { id, name }); }
  tagInfo(id: number, category: string, color: number | null) { return invoke<void>("tag_info", { id, category, color }); }
  deleteTag(id: number) { return invoke<void>("tag_delete", { id }); }
  missingTracks() { return invoke<T.TrackRow[]>("library_missing"); }
  findMissing(folder: string) { return invoke<number>("library_find_missing", { folder }); }
  relocateTrack(id: number, path: string) { return invoke<T.TrackRow>("library_relocate", { id, path }); }
  duplicates() { return invoke<T.TrackRow[][]>("library_duplicates"); }
  mergeTracks(keep: number, others: number[]) { return invoke<void>("library_merge", { keep, others }); }
  previewLoad(trackId: number, seconds: number) { return invoke<number>("preview_load", { trackId, seconds }); }
  previewPlay(on: boolean) { return invoke<void>("preview_play", { on }); }
  previewSeek(seconds: number) { return invoke<void>("preview_seek", { seconds }); }
  previewSettings(gain: number, route: T.PreviewRoute) { return invoke<void>("preview_settings", { gain, route }); }
  previewSync(on: boolean) { return invoke<void>("preview_sync", { on }); }
  previewClose() { return invoke<void>("preview_close"); }
  saveText(path: string, text: string) { return invoke<void>("save_text", { path, text }); }
  suggestNext(trackId: number, energy: "steady" | "up" | "down", limit?: number) {
    return invoke<T.SuggestionRow[]>("suggest_next", { trackId, energy, limit: limit ?? null, tolerance: null });
  }

  playlists() { return invoke<T.PlaylistDto[]>("playlists"); }
  playlistTracks(id: number) { return invoke<T.TrackRow[]>("playlist_tracks", { id }); }
  createPlaylist(name: string, kind: "folder" | "list" | "smart", opts: { parent?: number | null; query?: string | null; tracks?: number[] } = {}) {
    return invoke<number>("playlist_create", { name, kind, parent: opts.parent ?? null, query: opts.query ?? null, tracks: opts.tracks ?? null });
  }
  renamePlaylist(id: number, name: string) { return invoke<void>("playlist_rename", { id, name }); }
  setPlaylistQuery(id: number, query: string) { return invoke<void>("playlist_set_query", { id, query }); }
  deletePlaylist(id: number) { return invoke<void>("playlist_delete", { id }); }
  addToPlaylist(id: number, tracks: number[]) { return invoke<void>("playlist_add", { id, tracks }); }
  removeFromPlaylist(id: number, indices: number[]) { return invoke<void>("playlist_remove", { id, indices }); }
  reorderPlaylist(id: number, from: number[], to: number) { return invoke<void>("playlist_reorder", { id, from, to }); }
  movePlaylist(id: number, parent: number | null, position: number) { return invoke<void>("playlist_move", { id, parent, position }); }
  setPlaylistTracks(id: number, tracks: number[]) { return invoke<void>("playlist_set_tracks", { id, tracks }); }
  copyFiles(ids: number[], dest: string, name: string, numbered: boolean) { return invoke<void>("tracks_copy_files", { ids, dest, name, numbered }); }
  orderPlaylist(id: number, energy: "steady" | "up" | "down") { return invoke<void>("playlist_order_set", { id, energy, start: null }); }
  history() { return invoke<T.HistoryEntry[]>("history"); }
  async historySessions() {
    const [current, sessions] = await invoke<[number | null, T.SessionDto[]]>("history_sessions");
    return { current, sessions };
  }
  sessionHistory(session: number) { return invoke<T.HistoryEntry[]>("history_of", { session }); }
  renameSession(session: number, name: string) { return invoke<void>("history_rename", { session, name }); }
  deleteSession(session: number) { return invoke<void>("history_delete", { session }); }
  tracklist() { return invoke<string>("history_tracklist"); }

  devices() { return invoke<T.DeviceInfo[]>("audio_devices"); }
  audioStatus() { return invoke<T.AudioStatus>("audio_status"); }
  saveSettings(settings: T.Settings) { return invoke<T.Settings>("settings_set", { settings }); }
  recordStart() { return invoke<string>("record_start"); }
  recordStop() { return invoke<string>("record_stop"); }
  importTrack(path: string) { return invoke<T.TrackRow>("library_import", { path }); }
  registerFiles(_files: File[]): string[] { return []; }
  inputDevices() { return invoke<T.DeviceInfo[]>("input_devices"); }
  studioGet(channel: number | null) { return invoke<T.StudioDto>("studio_get", { channel }); }
  studioSet(channel: number | null, settings: T.StudioDto) { return invoke<void>("studio_set", { channel, settings }); }
  setScope(source: T.ScopeSource) { return invoke<void>("scope_set", { source: String(source) }); }
  micState() { return invoke<T.MicState>("mic_status"); }
  async micRecordStart() { await invoke<string>("mic_record_start"); }
  micRecordStop(trim: boolean) { return invoke<T.MicTake>("mic_record_stop", { trim }); }

  automix(tracks: number[], options: T.AutomixRequest) { return invoke<T.MixProject>("automix", { tracks, options }); }
  saveProject(path: string, project: T.MixProject) { return invoke<void>("project_save", { path, project }); }
  openProject(path: string) { return invoke<T.MixProject>("project_open", { path }); }
  checkProject(project: T.MixProject) { return invoke<string[]>("project_check", { project }); }
  renderProject(project: T.MixProject, path: string, format?: string, targetLufs?: number | null) { return invoke<void>("project_render", { project, path, format: format ?? null, targetLufs: targetLufs ?? null }); }
  soundOpen(source: T.PadSource, bins: number) { return invoke<T.SoundOpened>("sound_open", { source, bins }); }
  soundRender(id: number, ops: T.EditOp[], bins: number) { return invoke<T.SoundView>("sound_render", { id, ops, bins }); }
  soundAudio(id: number, ops: T.EditOp[]) { return invoke<ArrayBuffer>("sound_audio", { id, ops }); }
  soundSave(id: number, ops: T.EditOp[], name: string) { return invoke<string>("sound_save", { id, ops, name }); }
  soundClose(id: number) { return invoke<void>("sound_close", { id }); }
  renderStems(project: T.MixProject, folder: string, format?: string) { return invoke<void>("project_render_stems", { project, folder, format: format ?? null }); }
  previewProject(project: T.MixProject, fromBeat: number, toBeat: number) { return invoke<ArrayBuffer>("project_preview", { project, fromBeat, toBeat }); }

  samplerLoad(pad: number, source: T.PadSource) { return invoke<T.PadInfo>("sampler_load", { pad, source }); }
  samplerClear(pad: number) { return invoke<T.PadInfo>("sampler_clear", { pad }); }
  samplerSet(pad: number, patch: T.PadPatch) { return invoke<T.PadInfo>("sampler_set", { pad, patch }); }
  samplerReset() { return invoke<T.PadInfo[]>("sampler_reset"); }
  samplerStopAll() { return invoke<void>("sampler_stop_all"); }
  samplerSequence(sequencer: T.SequencerDto) { return invoke<void>("sampler_sequence", { sequencer }); }
  addPracticeTracks() { return invoke<void>("practice_add"); }
  importRekordbox(path: string) { return invoke<void>("import_rekordbox", { path }); }
  importTraktor(path: string) { return invoke<void>("import_traktor", { path }); }
  importSerato(path: string) { return invoke<void>("import_serato", { path }); }
  importVirtualDj(path: string) { return invoke<void>("import_virtualdj", { path }); }
  exportRekordbox(path: string, playlist?: number | null) { return invoke<void>("export_rekordbox", { path, playlist: playlist ?? null }); }
  exportTraktor(path: string, playlist?: number | null) { return invoke<void>("export_traktor", { path, playlist: playlist ?? null }); }
  exportPlaylist(playlist: number, path: string) { return invoke<void>("export_playlist", { playlist, path }); }
  importM3u(path: string) { return invoke<number>("import_m3u", { path }); }

  async pickFolders(title = "Add music folders") {
    const r = await open({ directory: true, multiple: true, title });
    return r == null ? null : Array.isArray(r) ? r : [r];
  }
  async pickFiles(extensions: string[], title: string) {
    const r = await open({ multiple: true, title, filters: [{ name: title, extensions }] });
    return r == null ? null : Array.isArray(r) ? r : [r];
  }
  async pickSave(defaultName: string, extensions: string[]) {
    return (await save({ defaultPath: defaultName, filters: extensions.length ? [{ name: extensions.join(", "), extensions }] : undefined })) ?? null;
  }

  onTelemetry(cb: (t: T.Telemetry) => void) { return sub("telemetry", cb); }
  onDeckLoaded(cb: (d: T.DeckInfo) => void) { return sub("deck-loaded", cb); }
  onDeckEnded(cb: (deck: number) => void) { return sub("deck-ended", cb); }
  onJob(cb: (j: T.JobProgress) => void) { return sub("job", cb); }
  onLibraryChanged(cb: () => void) { return sub("library-changed", cb); }
  onHistoryChanged(cb: () => void) { return sub("history-changed", cb); }
  onAudioStatus(cb: (s: T.AudioStatus) => void) { return sub("audio-status", cb); }
  onError(cb: (m: string) => void) { return sub("error", cb); }
}
