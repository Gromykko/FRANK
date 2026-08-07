import { locationHour } from '../../utils/date';

// The location-clock hours a longer-range block covers, e.g. { start: "06",
// end: "12" }. Computed at render time (not baked into the cache) so it matches
// the meteogram's hour labels. `short` = "06–12"; compose "06:00–12:00" as
// needed. Lives outside normalize.ts because it depends on the location clock
// (utils/date -> CURRENT_LOCATION), which must NOT be pulled into the Worker —
// normalize.ts stays pure so the Worker can import its transforms.
export function blockHourRange(time: string, spanHours: number): { start: string; end: string; short: string } {
  const startHour = locationHour(time);
  // Derived from the timestamp, not `(startHour + spanHours) % 24`: local hour
  // arithmetic assumes every hour is 3600s, so on the two Europe/Copenhagen DST
  // days the printed end was an hour out (a 2027-03-28 00:00Z block ending at
  // 08:00 CEST was labelled 07).
  const endHour = locationHour(new Date(time).getTime() + spanHours * 3_600_000);
  const pad = (h: number) => `${h}`.padStart(2, '0');
  const start = pad(startHour);
  const end = pad(endHour);
  return { start, end, short: `${start}–${end}` };
}
