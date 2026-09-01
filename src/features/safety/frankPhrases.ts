import type { SafetyRating } from './analyzeSafetyConditions';

// FRANK's dot-matrix one-liners — GERTY-polite, sprinkled with Danish humor.
// Keep every phrase short enough to read in one pass; the display wraps
// statically so the explicit safety verdict never depends on motion.
// `{0}` is the location's water-body word ("fjord"/"bay", "Fjorden"/"Bugten"
// in Danish), filled in by the caller so Aarhus Bugt never gets called a fjord.
const PHRASES: Record<SafetyRating, string[]> = {
  safe: [
    'The available readings are within your limits',
    'Nothing in the available forecast crossed your limits',
    'The {0} fits your limits',
  ],
  caution: [
    'Check the details before you launch',
    'The {0} needs a second look',
    'Pause and check the conditions',
  ],
  danger: [
    'Nej tak. The {0} says no',
    'Even the Vikings called in sick today',
    'The {0} will still be here tomorrow',
    'The sea is angry. Coffee instead',
    'Outside your limits. Pick another time',
    'Best enjoyed from the shore today',
  ],
};

// Deterministic pick so the display doesn't reshuffle on every render: the
// same seed (selected day) and rating always give the same phrase.
export function getFrankPhrase(rating: SafetyRating, seed: string): string {
  const pool = PHRASES[rating];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return pool[hash % pool.length];
}
