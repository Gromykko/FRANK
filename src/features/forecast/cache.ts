import { CURRENT_LOCATION } from '../../config/locations';
import type { ForecastLocation } from '../../config/locations';
import type { WeatherData } from './types';
import { reviveReadings } from './normalize';
import { isValidForecastPayload } from './validatePayload';
import { shouldApplyForecastUpdate } from './forecastOrdering';
import { parseForecastInitialization } from './initialization';
import type { ForecastInitialization } from './initialization';
import {
  FORECAST_RELEASE_HEADERS,
  supportedForecastApiPaths,
} from './releaseContract';
import type { ReleaseMetadata } from './releaseContract';
import { FORECAST_WORKER_BASE } from './workerBase';

const WEATHER_CACHE_KEY_PREFIX = 'frank_weather_data_v2';
const CACHED_WORKER_FETCH_TIMEOUT_MS = 12 * 1000;
const AUTHORITY_MARKER_SCHEMA_VERSION = 1;
const AUTHORITY_MARKERS_TO_RETAIN = 8;
const FORECAST_GENERATIONS_TO_RETAIN = 2;

function getLegacyWeatherCacheKey(location: Pick<ForecastLocation, 'id'>): string {
  return `${WEATHER_CACHE_KEY_PREFIX}_${location.id}`;
}

function getAuthorityMarkerPrefix(location: ForecastLocation): string {
  return `${getLegacyWeatherCacheKey(location)}_config${location.forecastConfigRevision}_authority_`;
}

type BrowserForecastReleaseIdentity = Pick<
  ReleaseMetadata,
  'apiSchemaVersion' | 'modelRevision' | 'dataGenerationId' | 'payloadVersion'
>;

export function forecastReleaseCacheKey(
  location: Pick<ForecastLocation, 'id' | 'forecastConfigRevision'>,
  release: BrowserForecastReleaseIdentity,
): string {
  if (!Number.isSafeInteger(location.forecastConfigRevision)
    || location.forecastConfigRevision < 1) {
    throw new Error(`Invalid forecast config revision for location ${location.id}.`);
  }
  return [
    getLegacyWeatherCacheKey(location),
    `config${location.forecastConfigRevision}`,
    `api${release.apiSchemaVersion}`,
    `model${release.modelRevision}`,
    `generation_${encodeURIComponent(release.dataGenerationId)}`,
    `payload${release.payloadVersion}`,
  ].join('_');
}

function getWeatherCacheKey(location: ForecastLocation, data: WeatherData): string | null {
  const release = data.sources.release;
  const payloadVersion = data.sources.payloadVersion;
  if (
    release
    && Number.isSafeInteger(release.apiSchemaVersion)
    && release.apiSchemaVersion > 0
    && Number.isSafeInteger(release.modelRevision)
    && release.modelRevision > 0
    && typeof release.dataGenerationId === 'string'
    && release.dataGenerationId.length > 0
    && Number.isSafeInteger(release.payloadVersion)
    && release.payloadVersion > 0
    && payloadVersion === release.payloadVersion
  ) {
    // Never trust the human generation label as the only partition. Location
    // config, API, model and payload can each change independently, and an
    // accidental unchanged label must still create a different offline slot.
    return forecastReleaseCacheKey(location, release);
  }

  if (!Number.isSafeInteger(payloadVersion) || (payloadVersion as number) <= 0) return null;
  return `${getLegacyWeatherCacheKey(location)}_v${payloadVersion}`;
}

function getWeatherCacheKeys(location: ForecastLocation): string[] {
  const legacyKey = getLegacyWeatherCacheKey(location);
  const escapedLegacyKey = legacyKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const versionedKeyPattern = new RegExp(
    `^${escapedLegacyKey}_(?:config${location.forecastConfigRevision}_api\\d+_model\\d+_generation_.+_payload\\d+|v\\d+)$`,
  );
  return [
    ...Object.keys(localStorage).filter((key) => versionedKeyPattern.test(key)),
    legacyKey,
  ];
}

interface AuthorityMarker {
  schemaVersion: number;
  requestStartedAtMs: number;
  receivedAtMs: number;
  cacheKey: string;
}

function authorityMarkerEntries(location: ForecastLocation): Array<{
  storageKey: string;
  marker: AuthorityMarker;
}> {
  try {
    const prefix = getAuthorityMarkerPrefix(location);
    const cacheKeys = new Set(getWeatherCacheKeys(location));
    const entries: Array<{ storageKey: string; marker: AuthorityMarker }> = [];
    const latestPlausibleMs = Date.now() + 5 * 60 * 1000;

    for (const storageKey of Object.keys(localStorage)) {
      if (!storageKey.startsWith(prefix)) continue;
      try {
        const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Partial<AuthorityMarker> | null;
        if (
          value?.schemaVersion !== AUTHORITY_MARKER_SCHEMA_VERSION
          || !Number.isFinite(value.requestStartedAtMs)
          || !Number.isFinite(value.receivedAtMs)
          || (value.requestStartedAtMs as number) > latestPlausibleMs
          || (value.receivedAtMs as number) > latestPlausibleMs
          || typeof value.cacheKey !== 'string'
          || !cacheKeys.has(value.cacheKey)
        ) {
          try {
            localStorage.removeItem(storageKey);
          } catch {
            // Validation already excluded it from authority selection.
          }
          continue;
        }
        entries.push({ storageKey, marker: value as AuthorityMarker });
      } catch {
        // Invalid markers never influence which forecast is trusted.
        try {
          localStorage.removeItem(storageKey);
        } catch {
          // Best-effort scoped cleanup only.
        }
      }
    }

    return entries.sort((left, right) =>
      right.marker.requestStartedAtMs - left.marker.requestStartedAtMs
      || right.marker.receivedAtMs - left.marker.receivedAtMs
      || right.storageKey.localeCompare(left.storageKey));
  } catch {
    return [];
  }
}

type AuthorityMarkerEntry = ReturnType<typeof authorityMarkerEntries>[number];

function compatibleAuthorityMarkerEntries(
  location: ForecastLocation,
): AuthorityMarkerEntry[] {
  const compatibleReleaseSlots = new Set<string>();

  for (const cacheKey of getWeatherCacheKeys(location)) {
    try {
      const raw = localStorage.getItem(cacheKey);
      if (!raw) continue;
      const data = reviveReadings(JSON.parse(raw));
      if (
        data.sources?.release
        && isValidForecastPayload(data, location, { requireReleaseMetadata: true })
        && getWeatherCacheKey(location, data) === cacheKey
      ) {
        compatibleReleaseSlots.add(cacheKey);
      }
    } catch {
      // Corrupt, legacy and future-contract slots are never GC evidence. They
      // remain available to the shell that owns their contract.
    }
  }

  return authorityMarkerEntries(location)
    .filter(({ marker }) => compatibleReleaseSlots.has(marker.cacheKey));
}

function newestDistinctAuthorityCacheKeys(
  entries: readonly AuthorityMarkerEntry[],
  limit: number,
): Set<string> {
  const cacheKeys = new Set<string>();
  for (const { marker } of entries) {
    if (cacheKeys.size >= limit) break;
    cacheKeys.add(marker.cacheKey);
  }
  return cacheKeys;
}

function trimCompatibleAuthorityJournal(
  location: ForecastLocation,
  limit: number,
): void {
  const entries = compatibleAuthorityMarkerEntries(location);
  if (entries.length <= limit) return;

  // Keep the newest marker for every retained generation before filling the
  // remaining journal capacity with duplicate observations. Otherwise eight
  // ordinary refreshes of the current generation would evict the sole N-1
  // marker and make a later rollback indistinguishable from an unknown slot.
  const keep = new Set<string>();
  const representedCacheKeys = new Set<string>();
  for (const entry of entries) {
    if (representedCacheKeys.has(entry.marker.cacheKey)) continue;
    if (representedCacheKeys.size >= limit) break;
    representedCacheKeys.add(entry.marker.cacheKey);
    keep.add(entry.storageKey);
  }
  for (const entry of entries) {
    if (keep.size >= limit) break;
    keep.add(entry.storageKey);
  }
  for (const entry of entries) {
    if (!keep.has(entry.storageKey)) localStorage.removeItem(entry.storageKey);
  }
}

function pruneObsoleteForecastGenerations(location: ForecastLocation): void {
  const initialEntries = compatibleAuthorityMarkerEntries(location);
  const retainedCacheKeys = newestDistinctAuthorityCacheKeys(
    initialEntries,
    FORECAST_GENERATIONS_TO_RETAIN,
  );
  const obsoleteCacheKeys = [...new Set(
    initialEntries
      .map(({ marker }) => marker.cacheKey)
      .filter((cacheKey) => !retainedCacheKeys.has(cacheKey)),
  )];

  for (const cacheKey of obsoleteCacheKeys) {
    // Re-read the append-only journal before each deletion. A response from a
    // second tab may have completed since this sweep began; request-start
    // ordering, rather than completion order, still decides current and N-1.
    let latestEntries = compatibleAuthorityMarkerEntries(location);
    if (newestDistinctAuthorityCacheKeys(
      latestEntries,
      FORECAST_GENERATIONS_TO_RETAIN,
    ).has(cacheKey)) continue;

    for (const entry of latestEntries) {
      if (entry.marker.cacheKey === cacheKey) {
        localStorage.removeItem(entry.storageKey);
      }
    }

    // Close the common cross-tab interleave between the first journal read and
    // marker removal. If a newly appended authority marker promoted this slot,
    // leave both it and its payload intact for the next deterministic sweep.
    latestEntries = compatibleAuthorityMarkerEntries(location);
    if (newestDistinctAuthorityCacheKeys(
      latestEntries,
      FORECAST_GENERATIONS_TO_RETAIN,
    ).has(cacheKey)) continue;
    for (const entry of latestEntries) {
      if (entry.marker.cacheKey === cacheKey) {
        localStorage.removeItem(entry.storageKey);
      }
    }

    // `cacheKey` came from a fully validated, exact release-scoped slot. Never
    // enumerate broad application prefixes here: legacy forecasts, user
    // preferences, safety limits and the service worker's Cache Storage are
    // intentionally outside this generation-only garbage collector.
    localStorage.removeItem(cacheKey);
  }
}

function rememberServerAuthority(
  location: ForecastLocation,
  cacheKey: string,
  requestStartedAtMs: number,
): void {
  const marker: AuthorityMarker = {
    schemaVersion: AUTHORITY_MARKER_SCHEMA_VERSION,
    requestStartedAtMs,
    receivedAtMs: Date.now(),
    cacheKey,
  };
  try {
    const prefix = getAuthorityMarkerPrefix(location);
    const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
    const storageKey = `${prefix}${Math.trunc(requestStartedAtMs)}_${random}`;
    // Make space before the append. If quota pressure still wins, remove only
    // compatible FRANK authority markers and retry once. Future-contract and
    // legacy markers remain owned by the shells that wrote them.
    trimCompatibleAuthorityJournal(location, AUTHORITY_MARKERS_TO_RETAIN - 1);
    try {
      localStorage.setItem(storageKey, JSON.stringify(marker));
    } catch {
      trimCompatibleAuthorityJournal(location, 1);
      localStorage.setItem(storageKey, JSON.stringify(marker));
    }

    // Markers are append-only so two tabs cannot lose a compare-and-set race.
    // Retain the production-authoritative generation and its immediate
    // compatible predecessor. A rollback simply appends a newer observation,
    // so the former current generation becomes N-1 instead of being guessed
    // from model numbers or payload timestamps.
    pruneObsoleteForecastGenerations(location);
    trimCompatibleAuthorityJournal(location, AUTHORITY_MARKERS_TO_RETAIN);
  } catch {
    // Authority persistence is an offline enhancement. The validated network
    // response remains authoritative for the current in-memory session.
  }
}

function hasCurrentForecastWindow(data: WeatherData): boolean {
  const nowMs = Date.now();
  return data.hourly.some((hour) => {
    const startMs = new Date(hour.time).getTime();
    if (!Number.isFinite(startMs)) return false;
    const configuredSpanHours = hour.blockSpanHours ?? 1;
    const spanHours = Number.isFinite(configuredSpanHours) && configuredSpanHours > 0
      ? configuredSpanHours
      : 1;
    return startMs + spanHours * 60 * 60 * 1000 > nowMs;
  });
}

export function saveCachedWeatherData(data: WeatherData, location: ForecastLocation) {
  void persistCachedWeatherData(data, location);
}

function persistCachedWeatherData(
  data: WeatherData,
  location: ForecastLocation,
): string | null {
  // New writes must always carry an explicit compatible version and matching
  // location. The relaxed unversioned policy is only for already-saved legacy
  // data in readLocalCachedWeatherData below.
  if (!isValidForecastPayload(data, location)) return null;
  const cacheKey = getWeatherCacheKey(location, data);
  if (!cacheKey) return null;

  // `pending` is a historical response-only health state. Prepared-snapshot
  // routes never emit it, and persisting an older response would leave
  // "Checking…" stuck across reloads.
  if (data.sources.cacheHealth?.status === 'pending') return null;

  try {
    const existingRaw = localStorage.getItem(cacheKey);
    if (existingRaw) {
      try {
        const existing = reviveReadings(JSON.parse(existingRaw));
        if (
          isValidForecastPayload(existing, location, { allowLegacyMissingVersion: true })
          && !shouldApplyForecastUpdate(existing, data)
        ) {
          return cacheKey;
        }
      } catch {
        // A corrupt local value has no ordering claim. Replace it with the
        // validated incoming payload so one bad write cannot disable offline
        // recovery forever.
      }
    }
    // Do not write the pre-versioned legacy key. An older still-open app reads
    // that slot and cannot validate a future payload contract. Keeping one
    // slot per contract lets old/new tabs and rollback builds coexist safely.
    localStorage.setItem(cacheKey, JSON.stringify(data));
    return cacheKey;
  } catch {
    // Caching also provides the offline fallback, but storage can be blocked;
    // the live forecast remains usable for the current session.
    return null;
  }
}

async function persistServerAuthoritativeWeatherData(
  data: WeatherData,
  location: ForecastLocation,
  requestStartedAtMs: number,
): Promise<string | null> {
  const persistAndRecordAuthority = (): string | null => {
    const cacheKey = persistCachedWeatherData(data, location);
    if (cacheKey) rememberServerAuthority(location, cacheKey, requestStartedAtMs);
    return cacheKey;
  };

  // Payload, authority marker and N-2 sweep form one cross-tab transaction.
  // Without an origin-wide lock, one tab can persist a rollback payload while
  // another tab deletes that same formerly-N-2 slot just before its new marker
  // is appended. Web Locks serializes participating current/N-1 shells; the
  // synchronous fallback preserves normal offline caching on older browsers,
  // with the append-only journal's repeated reads remaining best-effort there.
  const lockManager = globalThis.navigator?.locks;
  if (!lockManager) return persistAndRecordAuthority();
  try {
    return await lockManager.request(
      `frank-forecast-cache:${location.id}:config${location.forecastConfigRevision}`,
      persistAndRecordAuthority,
    );
  } catch {
    return persistAndRecordAuthority();
  }
}

function readLocalCachedWeatherData(location: ForecastLocation): WeatherData | null {
  let cacheKeys: string[];
  try {
    cacheKeys = getWeatherCacheKeys(location);
  } catch {
    return null;
  }

  let best: WeatherData | null = null;
  const candidates = new Map<string, WeatherData>();
  for (const cacheKey of cacheKeys) {
    try {
      const raw = localStorage.getItem(cacheKey);
      if (!raw) continue;

      const parsed = reviveReadings(JSON.parse(raw));
      // Accept any structurally usable saved forecast that still covers now or
      // the future. Its build age is presentation state, not a load gate:
      // deriveCacheStatus marks data older than six hours as stale and App shows
      // the caution banner. Rejecting it here instead strands an offline paddler
      // on the no-forecast screen despite having actionable hours on the device.
      if (!isValidForecastPayload(parsed, location, { allowLegacyMissingVersion: true }) || !hasCurrentForecastWindow(parsed)) {
        continue;
      }

      // New release-stamped writes always use the exact slot derived from all
      // browser-facing axes. Retain `_vN`/unversioned recovery for an older
      // installed shell, but never accept a partially scoped API slot such as
      // the pre-hardening `_apiN_generation_X` form.
      const expectedCacheKey = getWeatherCacheKey(location, parsed);
      const legacyVersionKey = Number.isSafeInteger(parsed.sources.payloadVersion)
        ? `${getLegacyWeatherCacheKey(location)}_v${parsed.sources.payloadVersion}`
        : null;
      if (
        parsed.sources.release
        && expectedCacheKey !== cacheKey
        && cacheKey !== getLegacyWeatherCacheKey(location)
        && cacheKey !== legacyVersionKey
      ) continue;
      if (
        !parsed.sources.release
        && cacheKey !== getLegacyWeatherCacheKey(location)
        && expectedCacheKey !== cacheKey
      ) continue;

      let candidate = parsed;
      if (parsed.sources.cacheHealth?.status === 'pending') {
        // Heal copies written by older clients before pending became
        // response-only. The overwritten completed status cannot be recovered,
        // so stale is the conservative stable state: usable data, amber honesty,
        // and never a permanent in-flight claim. Write back to the same key so
        // an unversioned legacy copy is healed without recursing through save.
        candidate = {
          ...parsed,
          sources: {
            ...parsed.sources,
            cacheHealth: { ...parsed.sources.cacheHealth, status: 'stale' },
          },
        };
        try {
          localStorage.setItem(cacheKey, JSON.stringify(candidate));
        } catch {
          // The healed in-memory copy is still safer for this session when a
          // browser policy blocks the best-effort persistence repair.
        }
      }

      candidates.set(cacheKey, candidate);
      if (!best || shouldApplyForecastUpdate(best, candidate)) best = candidate;
    } catch {
      // One corrupt copy/version must not mask another valid offline forecast.
    }
  }

  // The most recent completed Worker response decides which compatible model
  // generation is production-authoritative. This is deliberately separate
  // from fetchedAt: immediately before promotion the old cron can build a few
  // minutes after the shadow generation, and an intentional rollback must be
  // able to select N-1 again. If that slot is corrupt/expired, degrade to the
  // best other validated copy instead of letting a marker strand the app.
  const authoritative = authorityMarkerEntries(location)
    .map(({ marker }) => candidates.get(marker.cacheKey))
    .find((candidate): candidate is WeatherData => Boolean(candidate));
  return authoritative ?? best;
}

interface WorkerCacheRead {
  data: WeatherData | null;
  initialization: ForecastInitialization | null;
  failureKind: 'network' | 'response' | null;
  serverAuthority: boolean;
  serverFallback: boolean;
}

type ResponseGenerationRole = 'authority' | 'fallback' | 'unproven';

function classifyResponseGeneration(response: Response, data: WeatherData): ResponseGenerationRole {
  const release = data.sources.release;
  if (!release) return 'unproven';
  // Real fetch responses always expose Headers. Keeping this boundary
  // fail-closed also makes non-browser adapters and lightweight test doubles
  // harmless: missing release evidence can never grant generation authority.
  if (!response.headers || typeof response.headers.get !== 'function') return 'unproven';
  const ready = response.headers.get(FORECAST_RELEASE_HEADERS.generationReady);
  if (ready !== 'true' && ready !== 'false') return 'unproven';
  const integerHeader = (name: string): number | null => {
    const value = response.headers.get(name);
    if (value === null || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const target = {
    apiSchemaVersion: integerHeader(FORECAST_RELEASE_HEADERS.apiSchema),
    modelRevision: integerHeader(FORECAST_RELEASE_HEADERS.modelRevision),
    dataGenerationId: response.headers.get(FORECAST_RELEASE_HEADERS.dataGeneration),
    assembledCacheSchema: integerHeader(FORECAST_RELEASE_HEADERS.assembledCacheSchema),
    marineCacheSchema: integerHeader(FORECAST_RELEASE_HEADERS.marineCacheSchema),
    payloadVersion: integerHeader(FORECAST_RELEASE_HEADERS.payloadVersion),
  };
  if (
    target.apiSchemaVersion === null
    || target.modelRevision === null
    || !target.dataGenerationId
    || target.assembledCacheSchema === null
    || target.marineCacheSchema === null
    || target.payloadVersion === null
  ) {
    return 'unproven';
  }
  if (ready === 'false') return 'fallback';
  return target.apiSchemaVersion === release.apiSchemaVersion
    && target.modelRevision === release.modelRevision
    && target.dataGenerationId === release.dataGenerationId
    && target.assembledCacheSchema === release.assembledCacheSchema
    && target.marineCacheSchema === release.marineCacheSchema
    && target.payloadVersion === release.payloadVersion
    ? 'authority'
    : 'unproven';
}

export async function resolveForecastApiResponse(
  paths: readonly string[],
  fetchEndpoint: (path: string) => Promise<Response>,
  location: ForecastLocation,
): Promise<{
  response: Response | null;
  initialization: ForecastInitialization | null;
  usedAvailabilityFallback: boolean;
}> {
  let lastResponse: Response | null = null;
  let targetInitialization: ForecastInitialization | null = null;
  let usedAvailabilityFallback = false;

  for (const [index, path] of paths.entries()) {
    const response = await fetchEndpoint(path);
    lastResponse = response;
    if (response.ok) return { response, initialization: null, usedAvailabilityFallback };
    if (response.status === 404) continue;

    const initialization = await parseForecastInitialization(response, location);
    if (!initialization) {
      // A malformed or hard response must not be disguised by an older API.
      return { response, initialization: null, usedAvailabilityFallback: false };
    }

    targetInitialization ??= initialization;
    if (index < paths.length - 1) {
      // Expand-contract rollout: /api/v2 may still be preparing at this edge
      // while the audited /api/v1 representation is complete. Try only the
      // explicitly supported N-1 route; generic errors remain fail-closed.
      usedAvailabilityFallback = true;
      continue;
    }
    return {
      response: null,
      initialization: targetInitialization,
      usedAvailabilityFallback: false,
    };
  }

  return targetInitialization
    ? { response: null, initialization: targetInitialization, usedAvailabilityFallback: false }
    : { response: lastResponse, initialization: null, usedAvailabilityFallback: false };
}

async function readWorkerCachedWeatherData(
  location: ForecastLocation,
  timeoutMs = CACHED_WORKER_FETCH_TIMEOUT_MS,
): Promise<WorkerCacheRead> {
  if (!FORECAST_WORKER_BASE) {
    return {
      data: null,
      initialization: null,
      failureKind: 'response',
      serverAuthority: false,
      serverFallback: false,
    };
  }

  let receivedResponse = false;
  const requestStartedAtMs = Date.now();
  try {
    const deadlineAt = requestStartedAtMs + timeoutMs;
    const fetchEndpoint = async (path: string): Promise<Response> => {
      // One total deadline covers every explicitly supported API revision. A
      // future client may try /api/v2 then /api/v1 during an expand-contract
      // release; a stalled request must not earn another full timeout.
      const remainingMs = Math.max(1, deadlineAt - Date.now());
      const response = await fetch(`${FORECAST_WORKER_BASE}${path}`, {
        cache: 'no-store',
        // Kayakers open this on fjord-edge mobile signal, where a socket can
        // stay open indefinitely without ever answering. Without a deadline
        // the saved forecast never gets a chance to take over.
        signal: AbortSignal.timeout(remainingMs),
      });
      receivedResponse = true;
      return response;
    };

    const resolved = await resolveForecastApiResponse(
      supportedForecastApiPaths(location.id),
      fetchEndpoint,
      location,
    );
    const response = resolved.response;
    if (resolved.initialization) {
      return {
        data: null,
        initialization: resolved.initialization,
        failureKind: null,
        serverAuthority: false,
        serverFallback: false,
      };
    }
    if (!response) throw new Error('No supported forecast API route is configured.');

    if (!response.ok) {
      return {
        data: null,
        initialization: null,
        failureKind: 'response',
        serverAuthority: false,
        serverFallback: false,
      };
    }

    const parsed = reviveReadings(await response.json());
    // USABILITY, not freshness: does this payload still cover the hours the app
    // needs to render? How OLD it is belongs to the status layer, which reports
    // it honestly (deriveCacheStatus demotes the tone by wall clock, and the
    // page banner fires past 6 h).
    //
    // Gating this on the local copy's 6-hour age cap instead was a real outage:
    // when the worker's cron stalled, an 11-hour-old but perfectly renderable
    // forecast — hourly rows running days ahead — was refused here, so
    // loadCachedWeatherData returned null and users got the dead "Kan ikke nå
    // prognosen" screen instead of the forecast plus "Viser ældre data". Same
    // Explicitly audited compatible generations stay accepted so Worker and
    // Pages can expand before they contract. An unknown payload contract is
    // different: this client must not render it or overwrite a validated copy.
    // A stable API response must identify the release that produced it. The
    // release gate owns target-generation readiness; this trust boundary owns
    // the shape that a kayaker's browser is allowed to render and persist.
    if (
      isValidForecastPayload(parsed, location, { requireReleaseMetadata: true })
      && hasCurrentForecastWindow(parsed)
    ) {
      // Prepared-snapshot routes never return an in-flight health overlay.
      // Treat one as an incompatible response rather than persisting a state
      // that has no completion/pickup contract in this architecture.
      if (parsed.sources.cacheHealth?.status === 'pending') {
        return {
          data: null,
          initialization: null,
          failureKind: 'response',
          serverAuthority: false,
          serverFallback: false,
        };
      }
      const generationRole = resolved.usedAvailabilityFallback
        ? 'fallback'
        : classifyResponseGeneration(response, parsed);
      const serverAuthority = generationRole === 'authority';
      // Missing or contradictory release headers are not proof of a control-
      // plane promotion. The body remains usable as an availability response,
      // but across generations it gets the same non-demotion treatment as an
      // explicit ready=false fallback.
      const serverFallback = generationRole !== 'authority';
      if (serverAuthority) {
        // Only a completed, fully validated HTTP 200 can change offline
        // generation authority. Initialization, malformed/error responses,
        // local saves and transient pending overlays never create a marker.
        await persistServerAuthoritativeWeatherData(
          parsed,
          location,
          requestStartedAtMs,
        );
      } else {
        persistCachedWeatherData(parsed, location);
      }
      return {
        data: parsed,
        initialization: null,
        failureKind: null,
        serverAuthority,
        serverFallback,
      };
    }
  } catch {
    return {
      data: null,
      initialization: null,
      failureKind: receivedResponse ? 'response' : 'network',
      serverAuthority: false,
      serverFallback: false,
    };
  } finally {
    // In the `finally`, not before the fetch. Setting it up front collapsed the
    // documented "in flight" state (undefined) into "attempted and not reached"
    // (null) for the whole duration of the request, so on every boot
    // deriveCacheStatus briefly concluded the worker was unreachable and the
    // status aria-label announced a refresh failure that had not happened.
    workerAttempted = true;
  }

  return {
    data: null,
    initialization: null,
    failureKind: 'response',
    serverAuthority: false,
    serverFallback: false,
  };
}

export interface LoadCacheOptions {
  localOnly?: boolean;
  preferWorker?: boolean;
}

// Where the payload came from, and therefore whether the worker was reachable.
//
// This is reported rather than inferred on purpose. Callers used to answer "did
// we reach the worker?" by reading the worker's OWN `lastAttemptAt` stamp out of
// the payload and comparing it to the clock — but that stamp is deliberately
// operational rather than a record of this browser's request. The Worker now
// overlays an anomaly-aware heartbeat when safe, but that still cannot prove
// this browser reached it. The old age check produced an amber
// "Could not reach the forecast service" banner shown immediately after a
// perfectly successful fetch. The fetch layer knows the answer exactly; nothing
// downstream should be deducing it from someone else's throttled bookkeeping.
export type CacheSource = 'worker' | 'local' | null;

export interface LoadCacheResult {
  data: WeatherData | null;
  from: CacheSource;
  initialization?: ForecastInitialization;
  failureKind?: 'network' | 'response';
  serverAuthority?: boolean;
  serverFallback?: boolean;
}

// Contact record for this browser session. Three states, and the difference
// between the last two matters:
//
//   undefined -> no attempt has finished yet (boot, in flight). Judge nothing.
//   null      -> an attempt finished and the worker was NOT reached.
//   number    -> the worker was last reached at this time.
//
// Collapsing the middle case into "unknown" would put the original bug straight
// back: boot with a dead worker but a live connection, fall back to the saved
// copy, and its stale `status:'current'` would render as a green "Checked".
let workerAttempted = false;
let lastWorkerContactMs: number | null = null;
export function getWorkerContactMs(): number | null | undefined {
  return workerAttempted ? lastWorkerContactMs : undefined;
}

export async function loadCachedWeatherData(
  location = CURRENT_LOCATION,
  options: LoadCacheOptions = {}
): Promise<LoadCacheResult> {
  if (options.localOnly) {
    const local = readLocalCachedWeatherData(location);
    return { data: local, from: local ? 'local' : null };
  }

  if (options.preferWorker) {
    // Browser requests only read prepared snapshots; they never perform a cold
    // provider build. The same fjord-edge deadline therefore applies whether
    // or not a local fallback already exists.
    const local = readLocalCachedWeatherData(location);
    const workerResult = await readWorkerCachedWeatherData(
      location,
      CACHED_WORKER_FETCH_TIMEOUT_MS,
    );
    if (workerResult.data) {
      lastWorkerContactMs = Date.now();
      return {
        data: workerResult.data,
        from: 'worker',
        ...(workerResult.serverAuthority ? { serverAuthority: true } : {}),
        ...(workerResult.serverFallback ? { serverFallback: true } : {}),
      };
    }

    if (workerResult.initialization) {
      lastWorkerContactMs = Date.now();
      // A still-usable local snapshot remains the right UI when one exists.
      // Keep the classified initialization alongside it: the Worker DID answer
      // and told us it is preparing this location. Dropping that fact made the
      // hook misclassify a healthy 503 contract as a failed refresh, producing
      // three contradictory warnings over the saved forecast.
      return {
        data: local,
        from: local ? 'local' : null,
        initialization: workerResult.initialization,
      };
    }

    return {
      data: local,
      from: local ? 'local' : null,
      // Preserve the failure classification even when the local fallback is
      // usable. A valid initialization response is handled calmly above, while
      // true network and malformed/error responses must remain distinguishable
      // and surface through the established failure presentation.
      ...(workerResult.failureKind ? { failureKind: workerResult.failureKind } : {}),
    };
  }

  const local = readLocalCachedWeatherData(location);
  if (local) return { data: local, from: 'local' };

  const workerResult = await readWorkerCachedWeatherData(
    location,
    CACHED_WORKER_FETCH_TIMEOUT_MS,
  );
  if (workerResult.data) lastWorkerContactMs = Date.now();
  if (workerResult.initialization) lastWorkerContactMs = Date.now();
  return {
    data: workerResult.data,
    from: workerResult.data ? 'worker' : null,
    ...(workerResult.serverAuthority ? { serverAuthority: true } : {}),
    ...(workerResult.serverFallback ? { serverFallback: true } : {}),
    ...(workerResult.initialization ? { initialization: workerResult.initialization } : {}),
    ...(workerResult.failureKind ? { failureKind: workerResult.failureKind } : {}),
  };
}
