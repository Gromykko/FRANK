// Midpoint bearing of a wind sector [min, max] in compass degrees, wrap-aware
// (a sector may cross north, e.g. 315°–45°).
export function sectorMidBearing(min: number, max: number): number {
  let end = max;
  if (end <= min) end += 360;
  return (min + (end - min) / 2) % 360;
}

const COMPASS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// Nearest 8-point compass name for a bearing in degrees. A missing wind
// direction arrives as NaN, which indexed the table out of bounds and rendered
// the literal string "undefined" next to "NaN°".
export function compassPoint(bearingDeg: number): string {
  if (!Number.isFinite(bearingDeg)) return '—';
  return COMPASS_8[Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8];
}
