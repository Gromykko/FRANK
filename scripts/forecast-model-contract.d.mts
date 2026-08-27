import type { ReleaseMetadata } from '../src/features/forecast/releaseContract';

export const REPOSITORY_ROOT: string;
export const FORECAST_MODEL_BASELINE_FILE: string;
export const FORECAST_SEMANTIC_BOUNDARY_ID: string;
export const FORECAST_SEMANTIC_INPUT_FILES: readonly string[];
export const FORECAST_OPERATIONAL_INPUT_FILES: readonly string[];

export type TextFileReader = (fileName: string, encoding: 'utf8') => Promise<string>;

export interface ForecastModelLocationInput {
  id: string;
  forecastConfigRevision: number;
  coordinate?: unknown;
  timezone?: unknown;
  dmiCollections?: unknown;
  emmaId?: unknown;
  kommuneAliases?: unknown;
}

export interface ForecastModelLocationSnapshot {
  id: string;
  forecastConfigRevision: number;
  inputHash: string;
}

export interface ForecastModelSnapshot {
  schemaVersion: number;
  semanticBoundary: string;
  release: Readonly<ReleaseMetadata>;
  semanticInputs: Record<string, string>;
  locations: ForecastModelLocationSnapshot[];
}

export interface ForecastModelDiff {
  releaseChanged: boolean;
  changedSemanticInputs: string[];
  addedLocations: string[];
  removedLocations: string[];
  changedLocations: string[];
  revisionOnlyLocations: string[];
}

export function assertForecastSemanticBoundary(options?: {
  repositoryRoot?: string;
  readFileImpl?: TextFileReader;
}): Promise<{
  id: string;
  semanticFiles: string[];
  operationalFiles: string[];
}>;
export function buildForecastModelSnapshot(options: {
  release: Readonly<ReleaseMetadata>;
  locations: ForecastModelLocationInput[];
  repositoryRoot?: string;
  readFileImpl?: TextFileReader;
}): Promise<ForecastModelSnapshot>;
export function readForecastModelBaseline(options?: {
  baselineFile?: string;
  readFileImpl?: TextFileReader;
}): Promise<ForecastModelSnapshot>;
export function describeForecastModelDiff(
  baseline: ForecastModelSnapshot,
  current: ForecastModelSnapshot,
): ForecastModelDiff;
export function assertRecordableForecastModelTransition(options: {
  baseline: ForecastModelSnapshot;
  current: ForecastModelSnapshot;
  auditedPreviousReleases: readonly Readonly<ReleaseMetadata>[];
}): ForecastModelDiff;
export function assertForecastModelBaseline(options: {
  release: Readonly<ReleaseMetadata>;
  locations: ForecastModelLocationInput[];
  baselineFile?: string;
  repositoryRoot?: string;
  readFileImpl?: TextFileReader;
}): Promise<ForecastModelSnapshot>;
export function recordForecastModelBaseline(options?: {
  contract?: {
    release: Readonly<ReleaseMetadata>;
    locations: ForecastModelLocationInput[];
    auditedPreviousReleases: readonly Readonly<ReleaseMetadata>[];
  };
  baselineFile?: string;
  repositoryRoot?: string;
  readFileImpl?: TextFileReader;
  writeFileImpl?: (fileName: string, contents: string, encoding: 'utf8') => Promise<void>;
}): Promise<ForecastModelSnapshot>;
