import type { WeatherWarning } from './types';

// Official DMI warnings ("varsler") reach us through MeteoAlarm's Denmark CAP
// feed (DMI is the issuing EUMETNET member). The feed is one flat Atom document
// for all of Denmark; we filter it to a location's EMMA region (e.g. DK004 =
// Østjylland, which covers both Horsens and Vejle). CC BY 4.0 — attribute
// MeteoAlarm / DMI in the footer.
export const METEOALARM_DENMARK_FEED =
  'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-denmark';

// There is no stable per-region DMI deep link — the region is a map interaction
// on DMI's page — so the stripe links out to the general varsler page.
export const DMI_VARSLER_URL = 'https://www.dmi.dk/varsler';

// DMI's feed names regions in Danish (areaDesc); the UI is English. One shared
// map so every consumer (warning stripe, planner badges) uses the same English
// name. "Flere landsdele" is the feed's multi-region value for nationwide
// warnings; unknown names fall back to the Danish original so a feed change
// never blanks the region. Pure data — safe for the Worker import chain.
// The 8 real regions as the feed spells them (extracted from live entries
// 2026-07-14: DK001–DK008).
const REGION_EN: Record<string, string> = {
  'Nordjylland': 'North Jutland',
  'Midt- og Vestjylland': 'Central & West Jutland',
  'Bornholm': 'Bornholm',
  'Østjylland': 'East Jutland',
  'Syd- og Sønderjylland': 'South Jutland',
  'Fyn': 'Funen',
  'Vest- og Sydsjælland samt Lolland-Falster': 'West & South Zealand, Lolland-Falster',
  'København og Nordsjælland': 'Copenhagen & North Zealand',
};

// The warning level word shown next to a colour ("Yellow warning") — shared so
// the stripe and the planner badges speak identically.
export const LEVEL_WORD: Record<WeatherWarning['colour'], string> = {
  yellow: 'Yellow',
  orange: 'Orange',
  red: 'Red',
};

// The full English area phrase for a warning ("East Jutland region",
// "several regions", "your region") — including the suffix decision, so
// callers never build "Flere landsdele region".
export function describeWarningArea(areaDesc: string | undefined): string {
  if (!areaDesc) return 'your region';
  if (areaDesc === 'Flere landsdele') return 'several regions';
  return `${REGION_EN[areaDesc] ?? areaDesc} region`;
}

const SEVERITY_TO_COLOUR: Record<string, WeatherWarning['colour']> = {
  Moderate: 'yellow',
  Severe: 'orange',
  Extreme: 'red',
};

const COLOUR_RANK: Record<WeatherWarning['colour'], number> = {
  red: 3,
  orange: 2,
  yellow: 1,
};

// Pull the text of a CAP element, tolerating the optional `cap:` namespace.
function pick(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<(?:cap:)?${tag}>([^<]*)</(?:cap:)?${tag}>`));
  return match ? match[1].trim() : undefined;
}

// The awareness colour leads the event string ("yellow Rain"); fall back to the
// CAP severity if it's ever absent. Returns the colour and the plain hazard name.
function splitEvent(
  event: string | undefined,
  severity: string | undefined
): { colour: WeatherWarning['colour']; label: string } {
  const parts = (event ?? '').trim().split(/\s+/);
  const lead = parts[0]?.toLowerCase();
  const isColour = lead === 'yellow' || lead === 'orange' || lead === 'red';
  const colour = isColour
    ? (lead as WeatherWarning['colour'])
    : SEVERITY_TO_COLOUR[severity ?? ''] ?? 'yellow';
  const label = (isColour ? parts.slice(1).join(' ') : event ?? '').trim() || 'Weather';
  return { colour, label };
}

// Parse the MeteoAlarm Denmark Atom feed to the active/upcoming warnings for one
// EMMA region. Pure string work (no DOMParser — this runs in the Worker too).
// Already-expired warnings are dropped; the rest keep their effective/expires
// times so the client can re-filter as `now` moves without a rebuild.
export function parseMeteoalarmFeed(
  xml: string,
  emmaId: string,
  nowMs: number = Date.now(),
  warningUrl: string = DMI_VARSLER_URL
): WeatherWarning[] {
  if (!emmaId || typeof xml !== 'string') return [];

  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  const warnings: WeatherWarning[] = [];

  for (const entry of entries) {
    // A single entry can carry several EMMA_ID geocodes (e.g. a nationwide
    // warning listing many regions), so match them all — not just the first.
    const regions = [...entry.matchAll(/EMMA_ID<\/valueName>\s*<value>\s*([^<\s]+)/g)].map((m) => m[1]);
    if (!regions.includes(emmaId)) continue;

    const expires = pick(entry, 'expires');
    const expiresMs = expires ? Date.parse(expires) : Number.NaN;
    // Drop warnings that have already lapsed; keep active and upcoming ones.
    if (!Number.isFinite(expiresMs) || nowMs >= expiresMs) continue;

    const severity = pick(entry, 'severity');
    const { colour, label } = splitEvent(pick(entry, 'event'), severity);
    const effective = pick(entry, 'effective') ?? expires!;
    // The entry's second link is the per-warning CAP detail (public, no token)
    // whose "Gældende for:" text names the covered kommunes — the coverage
    // check below reads it.
    const detailUrl = entry.match(/href="(https:\/\/feeds\.meteoalarm\.org\/api\/v1\/warnings\/[^"]+)"/)?.[1];

    warnings.push({
      event: label,
      colour,
      severity,
      areaDesc: pick(entry, 'areaDesc'),
      effective,
      onset: pick(entry, 'onset'),
      expires: expires!,
      title: entry.match(/<title>([^<]*)<\/title>/)?.[1]?.trim(),
      url: warningUrl,
      detailUrl,
    });
  }

  // The feed re-lists the same warning with a fresh "effective" stamp each time
  // it's re-issued, so a single hazard can appear several times. Collapse to one
  // per distinct hazard (event + colour + onset + expires) so the count and
  // "+N more" reflect real warnings, not re-issues.
  const unique = new Map<string, WeatherWarning>();
  for (const w of warnings) {
    unique.set(`${w.event}|${w.colour}|${w.onset ?? ''}|${w.expires}`, w);
  }

  // Most severe first, then soonest to expire — the order the stripe shows them.
  return [...unique.values()].sort(
    (a, b) =>
      COLOUR_RANK[b.colour] - COLOUR_RANK[a.colour] ||
      Date.parse(a.expires) - Date.parse(b.expires)
  );
}

// ── Kommune-coverage soft filter ─────────────────────────────────────────────
// The region feed is only granular to a landsdel (DK004 covers Horsens, Vejle
// AND Aarhus), but each warning's public CAP detail lists the covered kommunes
// by name ("Gældende for: Hedensted, Horsens, Odder…"). The soft filter uses
// that list ONLY to quiet warnings that demonstrably exclude the location —
// never to add local claims (no "covers Horsens", no amounts: that reading was
// deliberately rejected as over-promising). Fail-open by design: anything
// unclear stays exactly region-level.

// Markers that the CAP detail actually carries a covered-area list (da/kl/en).
// Without one we can't distinguish "not covered" from "list missing".
const AREA_LIST_MARKERS = /gældende for|valid for|atuuffia/i;

export type WarningCoverage = 'confirmed' | 'excluded' | 'unknown';

// Case-insensitive substring match against curated per-location aliases
// (Vejle/Kolding also match "Trekant" for "Trekant området").
export function assessKommuneCoverage(capXml: string, kommuneAliases: string[]): WarningCoverage {
  if (!capXml || kommuneAliases.length === 0) return 'unknown';
  const doc = capXml.toLowerCase();
  if (kommuneAliases.some((alias) => alias && doc.includes(alias.toLowerCase()))) return 'confirmed';
  // Only a document that demonstrably lists its covered areas can exclude us.
  return AREA_LIST_MARKERS.test(doc) ? 'excluded' : 'unknown';
}

// Cap on detail fetches per build: the deduped list is a handful of hazards,
// and the worker's cron runs on a subrequest budget.
const MAX_DETAIL_FETCHES = 6;

// Enrich warnings with coverage; any fetch failure leaves that warning
// untouched (unknown coverage → region-level display).
export async function enrichWarningCoverage(
  warnings: WeatherWarning[],
  kommuneAliases: string[] | undefined,
  fetchText: (url: string) => Promise<string>
): Promise<WeatherWarning[]> {
  if (!kommuneAliases || kommuneAliases.length === 0) return warnings;
  return Promise.all(
    warnings.map(async (warning, index) => {
      if (!warning.detailUrl || index >= MAX_DETAIL_FETCHES) return warning;
      try {
        const coverage = assessKommuneCoverage(await fetchText(warning.detailUrl), kommuneAliases);
        return { ...warning, coverage };
      } catch {
        return warning; // fail open
      }
    })
  );
}

// Warnings overlapping a time span [startMs, endMs), most severe first. The
// hazard window is [onset||effective, expires) — used to badge launch windows.
export function warningsOverlapping(
  warnings: WeatherWarning[] | undefined,
  startMs: number,
  endMs: number
): WeatherWarning[] {
  if (!warnings || warnings.length === 0) return [];
  return warnings.filter((w) => {
    // Hazard starts at onset, or effective if onset is absent/malformed.
    const onset = Date.parse(w.onset ?? '');
    const from = Number.isFinite(onset) ? onset : Date.parse(w.effective);
    const until = Date.parse(w.expires);
    return Number.isFinite(from) && Number.isFinite(until) && from < endMs && until > startMs;
  });
}
