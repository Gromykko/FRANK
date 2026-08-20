import type { ForecastLocation } from '../src/config/locationTypes';
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

// The two namespaces are disjoint (`instance-probe:` and `refresh:`). Values
// are checked/cast at those narrow lookup sites instead of weakening all
// Worker code with an untyped map.
export type EventMemo = Map<string, Promise<unknown>>;

export interface MetRawCache {
  lastModified: string;
  body: import('../src/features/forecast/normalize').MetForecastResponse;
}

export interface MarineIngredientEnvelope extends MarineInstance {
  schemaVersion: number;
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
  fetchedAt?: string;
  cacheHealth?: WorkerCacheHealth;
}

export interface ForecastInitializationMarker {
  schemaVersion: 1;
  status: 'initializing';
  locationId: string;
  lastAttemptAt: string;
  retryAfterSeconds: number;
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
  locations: HealthLocationEntry[];
  ages: HealthAge[];
  storageUnavailable: boolean;
}
