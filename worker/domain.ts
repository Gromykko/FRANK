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
}

// Event-local provider work uses disjoint namespaces (`instance-probe:`,
// `provider-circuit:`, and `refresh:`). Values are validated at those narrow
// lookup sites instead of weakening all Worker code with an untyped map.
export type EventMemo = Map<string, Promise<unknown>>;

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
  marineInstances: MarineInstances;
  forecast: ForecastData;
  weatherExpires: string;
  weatherLastModified?: string;
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

export interface HealthPayload {
  ok: boolean;
  service: 'frank-forecast';
  checkedAt: string;
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
