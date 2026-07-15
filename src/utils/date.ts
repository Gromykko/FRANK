import { CURRENT_LOCATION } from '../config/locations';

const TIMEZONE = CURRENT_LOCATION.timezone;
// Display locale for the formatters below. Defaults to en-GB (tests pin the
// English output); the LanguageProvider switches it to da-DK for Danish.
// The pinned formats above/below that do grouping MATH (hour numbers, date
// keys) stay locale-fixed on purpose.
let dateLocale: 'en-GB' | 'da-DK' = 'en-GB';

export function setDateLocale(locale: 'en-GB' | 'da-DK'): void {
  dateLocale = locale;
}

// Hour-of-day and calendar-day AT THE LOCATION, independent of the viewer's
// browser timezone. All grouping/positioning math (meteogram hour labels,
// calendar rows, day splits, "today" checks, sunrise matching) must use these
// — the labels above are already timezone-pinned, and mixing them with
// browser-local getHours()/getDate() misplaces everything for viewers
// outside Denmark.
const HOUR_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  hour: '2-digit',
  hourCycle: 'h23',
});

// en-CA renders as YYYY-MM-DD — a ready-made sortable day key.
const DATE_KEY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function locationHour(date: Date | number | string): number {
  return Number(HOUR_FORMAT.format(new Date(date)));
}

const HOUR_MINUTE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// Hour-of-day as a fraction (e.g. 05:45 → 5.75) at the location — positions
// sunrise/sunset/now markers on a 0–24 axis.
export function locationHourFraction(date: Date | number | string): number {
  const parts = HOUR_MINUTE_FORMAT.formatToParts(new Date(date));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour + minute / 60;
}

export function locationHourLabel(date: Date | number | string): string {
  return `${locationHour(date).toString().padStart(2, '0')}:00`;
}

export function locationDateKey(date: Date | number | string): string {
  return DATE_KEY_FORMAT.format(new Date(date));
}

export function isSameLocationDay(a: Date | number | string, b: Date | number | string): boolean {
  return locationDateKey(a) === locationDateKey(b);
}

export function formatTime(date: Date | number | string): string {
  return new Date(date).toLocaleTimeString(dateLocale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE,
  });
}

export function formatDateShort(date: Date | number | string): string {
  return new Date(date).toLocaleDateString(dateLocale, {
    weekday: 'short',
    day: 'numeric',
    timeZone: TIMEZONE,
  });
}

export function formatDateMedium(date: Date | number | string): string {
  return new Date(date).toLocaleDateString(dateLocale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: TIMEZONE,
  });
}

export function formatWeekday(date: Date | number | string): string {
  return new Date(date).toLocaleDateString(dateLocale, {
    weekday: 'short',
    timeZone: TIMEZONE,
  });
}

export function formatDateTime(date: Date | number | string): string {
  return new Date(date).toLocaleString(dateLocale, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE,
  });
}
