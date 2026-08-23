import type { ForecastLocation } from '../src/config/locationTypes';
import type { ReleaseMetadata } from '../src/features/forecast/releaseContract';
import type { MetBlock } from '../src/features/forecast/normalize';
import type {
  HourlyData,
  SeriesPoint,
  WeatherData,
} from '../src/features/forecast/types';
import type { ExecutionPolicyInput } from './execution';

export type WorkerLocation = ForecastLocation;
export type MarineKind = 'water' | 'waves';

export interface MarineRunRef {
  collection?: string;
  id?: string;
}

export interface MarineInstance {
  collection: string;
  id: string;
}

export interface MarineInstances {
  water: MarineInstance;
  waves: MarineInstance;
}

export type CacheHealthStatus = NonNullable<WeatherData['sources']['cacheHealth']>['status'];
export type BusyProvider = NonNullable<
  NonNullable<WeatherData['sources']['cacheHealth']>['busyProvider']
>;

export interface WorkerCacheHealth
  extends Omit<NonNullable<WeatherData['sources']['cacheHealth']>, 'busyProvider'> {
  busyProvider?: BusyProvider;
  marineInstances?: MarineInstances;
}

export interface WorkerSources extends Omit<WeatherData['sources'], 'cacheHealth'> {
  payloadVersion: number;
  release?: ReleaseMetadata;
  cacheHealth?: WorkerCacheHealth;
}

export interface ForecastData extends Omit<WeatherData, 'sources'> {
  sources: WorkerSources;
}

export interface CacheHealthOptions {
  marineInstances?: MarineInstances;
  weatherExpires?: string;
  weatherLastModified?: string;
  message?: string;
  preserveAttemptAt?: boolean;
  needsRebuild?: boolean;
  checkedBy?: string;
  providerBusy?: boolean;
  busyProvider?: BusyProvider;
  degradedSources?: string[];
}

export interface RefreshOptions {
  force?: boolean;
  forceRebuild?: boolean;
  reason?: string;
  minIntervalMs?: number;
  executionPolicy?: ExecutionPolicyInput;
  eventMemo?: EventMemo;
  cached?: ForecastData | null;
  // Event-local output used only by scheduled refreshes. It distinguishes an
  // actual provider contact from a healthy policy skip and a failed/skipped
  // attempt without retaining cross-event state in module scope.
  cronOutcome?: {
    status: 'unreachable' | 'healthy-no-probe' | 'contacted';
    attemptedAt?: string;
  };
}

// Event-local provider work uses disjoint namespaces (`instance-probe:`,
// `provider-circuit:`, and `refresh:`). Values are validated at those narrow
// lookup sites instead of weakening all Worker code with an untyped map.
// Event-local coordination shared by every provider stage in one fetch/cron
// invocation. The Map owns in-flight/result memos; the counter is deliberately
// a property rather than a module global so concurrent Worker events can never
// spend one another's external-subrequest allowance.
export type EventMemo = Map<string, Promise<unknown>> & {
  externalSubrequestsStarted?: number;
};

export interface MarineBusyCircuit {
  status: 'open';
  provider: 'marine';
  busy: true;
  retryAfterSeconds: number;
}

export interface MetRawCache {
  locationId: string;
  forecastConfigRevision: number;
  lastModified: string;
  body: import('../src/features/forecast/normalize').MetForecastResponse;
}

export interface MarineIngredientEnvelope extends MarineInstance {
  schemaVersion: number;
  locationId: string;
  forecastConfigRevision: number;
  series: SeriesPoint[];
}

export interface MarineSeriesResult {
  series: SeriesPoint[];
  instance: MarineInstance;
  fallback: boolean;
  // Event-local evidence that this invocation received and validated a DMI
  // position response. Reusing the retained series is deliberately false.
  providerContacted: boolean;
  degraded?: boolean;
  busy?: boolean;
  notReady?: boolean;
}

export interface MarineSeeds {
  water: SeriesPoint[];
  waves: SeriesPoint[];
  instances?: MarineInstances;
}

export interface MetResult {
  weatherSeries: SeriesPoint[];
  blocks: MetBlock[];
  weatherExpires: string;
  weatherLastModified?: string;
  fallback: boolean;
  degraded?: boolean;
  busy?: boolean;
}

export interface ForecastBuildResult {
  degradedSources: string[];
  degradedBusy: boolean;
  degradedBusyProvider?: BusyProvider;
  // Required forecast providers only (MET or per-coordinate DMI), not the
  // advisory country-wide warning feed.
  providerContacted: boolean;
  marineInstances: MarineInstances;
  forecast: ForecastData;
  weatherExpires: string;
  weatherLastModified?: string;
}

// Mutable event-local evidence shared across provider stages so a successful
// required-provider response is not forgotten if a later stage or assembly
// step fails. It is never retained between Worker invocations.
export interface ProviderContactEvidence {
  providerContacted: boolean;
}

export interface MarineSeedPayload {
  hourly?: Array<Partial<HourlyData> & Pick<HourlyData, 'time'>>;
  sources?: {
    cacheHealth?: {
      marineInstances?: MarineInstances;
    };
  };
}

export interface HealthLocationEntry {
  id: string;
  areaName: string;
  hasCache: boolean;
  exactGenerationReady: boolean;
  availabilitySource:
    | 'generation'
    | `generation:${string}`
    | 'none';
  fetchedAt?: string;
  cacheHealth?: WorkerCacheHealth;
  initialization?: ForecastInitializationMarker;
  warningCount?: number;
  warningsSummary?: string;
}

export interface HealthReleaseReadiness {
  target: ReleaseMetadata;
  allLocationsReady: boolean;
  ready: string[];
  available: string[];
  fallback: string[];
  missing: string[];
}

export interface ForecastInitializationMarker {
  schemaVersion: 2;
  status: 'initializing';
  locationId: string;
  forecastConfigRevision: number;
  lastAttemptAt: string;
  retryAfterSeconds: number;
  provider: BusyProvider;
  busy: boolean;
}

export interface ForecastInitializingPayload {
  schemaVersion: 1;
  status: 'initializing';
  code: 'FORECAST_INITIALIZING';
  message: string;
  retryAfterSeconds: number;
  location: {
    id: string;
    name: string;
    areaName: string;
  };
}

export interface HealthAge {
  id: string;
  ageMs: number;
  checkAgeMs: number;
}

// One KV object recording that the cron ran and the latest persisted successful
// and unsuccessful outcome for each city. Healthy writes are sampled about
// every five scheduled ticks; anomalies and their recoveries bypass that
// throttle so an app-wide lastTickAt can never hide a city-specific failure.
export interface CronHeartbeat {
  schemaVersion: 2;
  lastTickAt: string;
  // Latest persisted successful provider contact for this city.
  locations: Record<string, string>;
  // Latest persisted budget-skipped or failed city attempt. A value at least as recent
  // as locations[id] blocks that city from inheriting the app-wide lastTickAt.
  unreachable: Record<string, string>;
}

export interface HealthPayload {
  ok: boolean;
  service: 'frank-forecast';
  checkedAt: string;
  cronHeartbeat?: {
    lastTickAt: string;
    ageMin: number | null;
  } | null;
  oldestCheckAgeMin: number | null;
  checkStaleAfterMin: number;
  oldestAgeMin: number | null;
  dataStaleAfterMin: number;
  reason: string | null;
  stalled: string[];
  missing: string[];
  storageAvailable: boolean;
  release: HealthReleaseReadiness;
  locations: HealthLocationEntry[];
  ages: HealthAge[];
  storageUnavailable: boolean;
}
