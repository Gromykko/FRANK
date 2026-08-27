import type { ReleaseMetadata } from '../src/features/forecast/releaseContract';

export const FORECAST_KV_BINDING: string;
export const FRANK_GENERATION_KEY_ROOT: string;
export const MAX_BULK_DELETE_KEYS: number;

export interface ListedKvKey {
  name: string;
}

export interface ForecastReleaseContract {
  release: Readonly<ReleaseMetadata>;
  auditedPreviousReleases: readonly Readonly<ReleaseMetadata>[];
  retiredApiSchemaVersions?: readonly number[];
}

export interface WorkerKvGcPlan {
  retainedPrefixes: string[];
  stalePrefixes: string[];
  deleteKeys: string[];
  retainedKeys: string[];
  ignoredKeys: string[];
}

export interface ParsedGenerationScopedKey {
  key: string;
  prefix: string;
  release: ReleaseMetadata;
}

export type ExecFileResult = { stdout: string; stderr: string };
export type ExecFileImpl = (
  file: string,
  args: string[],
  options: object,
) => Promise<ExecFileResult>;

export function generationKeyPrefix(release: Readonly<ReleaseMetadata>): string;
export function parseGenerationScopedKey(key: unknown): ParsedGenerationScopedKey | null;
export function planWorkerKvGc(options: {
  listedKeys: unknown;
  currentRelease: Readonly<ReleaseMetadata>;
  auditedPreviousReleases?: readonly Readonly<ReleaseMetadata>[];
  retiredApiSchemaVersions?: readonly number[];
}): WorkerKvGcPlan;
export function listRemoteForecastKvKeys(options?: {
  execFileImpl?: ExecFileImpl;
}): Promise<ListedKvKey[]>;
export function deleteRemoteForecastKvKeys(keys: string[], options?: {
  execFileImpl?: ExecFileImpl;
}): Promise<void>;
export function gcWorkerKv(options?: {
  apply?: boolean;
  attestedActiveRelease?: Readonly<ReleaseMetadata>;
  contract?: ForecastReleaseContract;
  listKeysImpl?: () => Promise<ListedKvKey[]>;
  deleteKeysImpl?: (keys: string[]) => Promise<void> | void;
  verificationAttempts?: number;
  verificationDelayMs?: number;
  sleepImpl?: (delayMs: number) => Promise<void>;
  logger?: { info: (...values: unknown[]) => void };
}): Promise<WorkerKvGcPlan & { applied: boolean }>;
