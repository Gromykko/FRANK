export function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function roundToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// Shown wherever a provider gave us no value for this hour. An en-dash reads
// as "no data" at a glance while staying close to digit width, so it sits
// cleanly in the meteogram's number cells ("4/–" beside "4/7"). Printing "NaN"
// or a fabricated 0.00 would not do either job.
export const NO_READING_TEXT = '–';

// The single display formatter for forecast readings. Missing values arrive as
// NaN by design (see NO_READING in features/forecast/normalize.ts) so they can
// never be mistaken for a measurement — this is where that becomes visible.
export function formatReading(value: number | undefined, decimals: number): string {
  return Number.isFinite(value) ? (value as number).toFixed(decimals) : NO_READING_TEXT;
}

// Same, with an explicit sign for values that swing either side of zero
// (water level relative to mean).
export function formatSigned(value: number | undefined, decimals: number): string {
  if (!Number.isFinite(value)) return NO_READING_TEXT;
  // Rounding a tiny negative water level yields -0, which prints as "-0.00".
  // Collapse it to a true zero so the row never shows a negative nothing.
  const rounded = roundToDecimals(value as number, decimals) || 0;
  return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(decimals)}`;
}
