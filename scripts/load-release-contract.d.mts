import type { ReleaseMetadata } from '../src/features/forecast/releaseContract';

export const DEFAULT_LOCATIONS_FILE: string;
export const DEFAULT_CONTRACT_FILE: string;
export const IMPLEMENTED_CONTINUOUS_API_SCHEMA_VERSION: number;

export class ContractError extends Error {}

export interface ParsedReleasePolicy {
  release: Readonly<ReleaseMetadata>;
  supportedApiSchemaVersions: number[];
  retiredApiSchemaVersions: number[];
  auditedPreviousReleases: Readonly<ReleaseMetadata>[];
  auditedPriorApiReleases: Readonly<ReleaseMetadata>[];
}

export function parseReleasePolicy(source: string): ParsedReleasePolicy;
export function parseReleaseContract(source: string): Readonly<ReleaseMetadata>;

export function loadReleaseContract(options?: {
  locationsFile?: string;
  contractFile?: string;
}): Promise<ParsedReleasePolicy & {
  locationIds: string[];
  locations: Array<{
    id: string;
    name: unknown;
    areaName: unknown;
    forecastConfigRevision: number;
    coordinate: {
      latitude: number;
      longitude: number;
    };
    timezone: unknown;
    dmiCollections: unknown;
    emmaId: unknown;
    kommuneAliases: unknown;
  }>;
  expectedVersion: number;
}>;
