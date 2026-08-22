import type { SafetyRating } from './analyzeSafetyConditions';

// FRANK's dot-matrix one-liners — GERTY-polite, sprinkled with Danish humor.
// Keep every phrase short enough to read in one pass; the display wraps
// statically so the explicit safety verdict never depends on motion.
// `{0}` is the location's water-body word ("fjord"/"bay", "Fjorden"/"Bugten"
// in Danish), filled in by the caller so Aarhus Bugt never gets called a fjord.
const PHRASES: Record<SafetyRating, string[]> = {
  safe: [
    'Good weather, go ahead!',
    'The {0} looks fint. Off you go',
    'Smooth as smørrebrød out there',
    'Even the herring approve today',
    'Grab the paddle before the weather changes its mind',
    // Moved out of the caution pool: "there's no bad weather" is a harmless
    // quip next to an all-clear, but under a CAUTION verdict it dismissed the
    // very warning it was sitting beneath.
    'No bad weather, only bad clothing',
  ],
  caution: [
    'Doable — but pick your moment',
    'The {0} is in a mood today',
    'Borderline. Very Jutland of it',
    'Manageable — keep a cool head',
    'Fine to go, but stay near the shore',
  ],
  danger: [
    'Nej tak. The {0} says no',
    'Even the Vikings called in sick today',
    'The {0} will still be here tomorrow',
    'The sea is angry. Coffee instead',
    'Not today. FRANK insists',
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
