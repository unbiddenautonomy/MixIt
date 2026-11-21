import { useEffect } from "react";
import { backend } from "../../backend";
import type { WaveformData } from "../../backend/types";
import { useApp } from "../../store/app";

const pending = new Set<number>();

/** The waveform for a track, fetched once and cached for the session. */
export function useWaveform(trackId: number | null | undefined): WaveformData | null {
  const w = useApp((s) => (trackId != null ? s.waveforms[trackId] : undefined));
  useEffect(() => {
    if (trackId == null || w || pending.has(trackId)) return;
    pending.add(trackId);
    backend()
      .waveform(trackId)
      .then((data) => useApp.setState((s) => ({ waveforms: { ...s.waveforms, [trackId]: data } })))
      .catch(() => {})
      .finally(() => pending.delete(trackId));
  }, [trackId, w]);
  return w ?? null;
}

export const DECK_COLORS = ["#38bdf8", "#f59e0b", "#a78bfa", "#a3e635"];
