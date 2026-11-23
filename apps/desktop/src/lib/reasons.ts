// Suggestion reasons in plain words, minus what the card's chips already say.

/**
 * The reasons worth reading on a suggestion card. The tempo change and key shift are
 * shown as chips, so the sentences that only repeat them are dropped; everything else
 * (key fit, energy, genre, sounds alike, history) stays, in order.
 */
export function cardReasons(reasons: string[], chips: { tempo: boolean; keyShift: boolean }): string[] {
  return reasons.filter((r) => {
    if (/^Same tempo\.?$/.test(r)) return false;
    if (chips.tempo && /^Needs a [+-]?[\d.]+ ?% tempo change\.?$/.test(r)) return false;
    if (chips.keyShift && /^Shift its key by /.test(r)) return false;
    return true;
  });
}
