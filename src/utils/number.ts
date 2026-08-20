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

// Water level, in centimetres with a sign, e.g. "+26" / "-14".
//
// The model gives metres, but every display in the app shows centimetres,
// because that is how DMI publishes vandstand to the public (cm relative to
// DVR90, no decimals) and how a Dane reads it. It also happens to be the
// cheapest format on screen: "+0.26" is five glyphs plus the width the sign
// steals from centring, which made the meteogram's Level row the only one
// pressed flat against its 44px cell. "+26" is three.
//
// Metres stay the unit everywhere a value is COMPARED (the planner's ±0.1 m
// window, the wind-against-water chop rule), so this is a display-boundary
// conversion only. Rounding happens after scaling, so ±0.004 m reads as "+0"
// rather than being nudged to a whole centimetre it never was.
export function formatLevelCm(metres: number | undefined): string {
  if (!Number.isFinite(metres)) return NO_READING_TEXT;
  return formatSigned((metres as number) * 100, 0);
}

// Same, with an explicit sign for values that swing either side of zero
// (water level relative to mean).
function formatSigned(value: number | undefined, decimals: number): string {
  if (!Number.isFinite(value)) return NO_READING_TEXT;
  // Rounding a tiny negative water level yields -0, which prints as "-0.00".
  // Collapse it to a true zero so the row never shows a negative nothing.
  const rounded = roundToDecimals(value as number, decimals) || 0;
  return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(decimals)}`;
}
