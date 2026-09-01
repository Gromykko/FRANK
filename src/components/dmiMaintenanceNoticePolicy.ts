import type { WeatherData } from '../features/forecast/types';

type CacheHealth = WeatherData['sources']['cacheHealth'];

// DMI says the maintenance can affect forecast publication from 31 August
// through 10 September 2026. Keep the end in Copenhagen time so the notice
// disappears after the final published day without requiring another deploy.
export const DMI_MAINTENANCE_START_MS = Date.parse('2026-08-31T00:00:00+02:00');
export const DMI_MAINTENANCE_END_MS = Date.parse('2026-09-11T00:00:00+02:00');

// This mirrors the Worker's existing maximum age for marine fallback data.
// It is only evidence for whether the maintenance notice is relevant; it does
// not change cache acceptance, freshness labels, or the safety verdict.
const MARINE_DELAY_EVIDENCE_MS = 12 * 60 * 60 * 1000;
const DMI_RUN_ID_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

function parseDmiRunIdMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = DMI_RUN_ID_PATTERN.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const parsedMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const parsed = new Date(parsedMs);

  // Date.UTC normalizes impossible dates (for example 30 February). The
  // round-trip keeps malformed provenance from manufacturing a delay signal.
  if (parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
    || parsed.getUTCHours() !== hour
    || parsed.getUTCMinutes() !== minute
    || parsed.getUTCSeconds() !== second) {
    return null;
  }

  return parsedMs;
}

function hasExpiredMarineProvenance(cacheHealth: CacheHealth, nowMs: number): boolean {
  const instances = cacheHealth?.marineInstances;
  return [instances?.water, instances?.waves].some((instance) => {
    const runMs = parseDmiRunIdMs(instance?.id);
    return runMs !== null && nowMs - runMs > MARINE_DELAY_EVIDENCE_MS;
  });
}

export function shouldShowDmiMaintenanceNotice(
  cacheHealth: CacheHealth,
  nowMs: number,
  online: boolean,
  refreshFailureConfirmed: boolean,
): boolean {
  if (nowMs < DMI_MAINTENANCE_START_MS || nowMs >= DMI_MAINTENANCE_END_MS) return false;

  const degradedSources = cacheHealth?.degradedSources ?? [];
  const marineDelayed = degradedSources
    .some((source) => source === 'water' || source === 'waves');
  const namedBusyProvider = cacheHealth?.providerBusy
    ? cacheHealth.busyProvider
    : undefined;
  if (marineDelayed || namedBusyProvider === 'marine') return true;

  // A named non-marine failure is stronger evidence than an old run id. Do
  // not turn a confirmed weather-only problem into a DMI maintenance notice.
  if (degradedSources.length > 0
    || namedBusyProvider === 'weather'
    || namedBusyProvider === 'services') return false;

  // A held last-complete payload may not carry the failed source, so old DMI
  // run provenance supplies a second, still marine-specific signal. It only
  // applies after an online refresh has actually failed; an offline or merely
  // sleeping browser can otherwise make healthy provenance look delayed.
  return online
    && refreshFailureConfirmed
    && hasExpiredMarineProvenance(cacheHealth, nowMs);
}
