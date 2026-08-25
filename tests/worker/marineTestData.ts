import type { ForecastLocation } from '../../src/config/locationTypes';
import type { SeriesPoint } from '../../src/features/forecast/types';
import { MARINE_INGREDIENT_CACHE_SCHEMA_VERSION } from '../../src/features/forecast/releaseContract';
import type { MarineIngredientEnvelope, MarineKind } from '../../worker/domain';
import { marineRunContract } from '../../worker/forecastModel';

export function completeMarineSeries(
  kind: MarineKind,
  runId: string,
  collection = kind === 'water' ? 'dkss_idw' : 'wam_nsb',
): SeriesPoint[] {
  const contract = marineRunContract(collection, runId);
  if (!contract || contract.kind !== kind) {
    throw new Error(`Unsupported ${kind} test run ${collection}/${runId}`);
  }
  return Array.from({ length: contract.expectedPointCount }, (_, index) => {
    const timeMs = contract.runStartMs + index * 60 * 60 * 1000;
    const base = { time: new Date(timeMs).toISOString(), timeMs };
    return kind === 'water'
      ? {
          ...base,
          tideLevel: 0.2 + index / 10_000,
          tempWater: 14,
          currentSpeed: 0.1,
          currentDirection: 90,
        }
      : {
          ...base,
          waveHeight: 0.3 + index / 10_000,
          wavePeriod: 3,
          waveDirection: 180,
        };
  });
}

export function completeMarineEnvelope(
  location: Pick<ForecastLocation, 'id' | 'forecastConfigRevision' | 'dmiCollections'>,
  kind: MarineKind,
  runId: string,
  collection = location.dmiCollections[kind][0],
): MarineIngredientEnvelope {
  const contract = marineRunContract(collection, runId);
  if (!contract || contract.kind !== kind) {
    throw new Error(`Unsupported ${kind} test envelope ${collection}/${runId}`);
  }
  const series = completeMarineSeries(kind, runId, collection);
  return {
    schemaVersion: MARINE_INGREDIENT_CACHE_SCHEMA_VERSION,
    locationId: location.id,
    forecastConfigRevision: location.forecastConfigRevision,
    marineKind: kind,
    collection,
    id: runId,
    expectedStartMs: contract.runStartMs,
    expectedEndMs: contract.expectedEndMs,
    seriesEndMs: contract.expectedEndMs,
    series,
  };
}
