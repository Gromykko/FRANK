import type { ForecastLocation } from '../../src/config/locationTypes';
import type { CronHeartbeat, WorkerCacheHealth } from '../../worker/domain';

const DEFAULT_TIMESTAMP = '2026-08-20T12:00:00.000Z';

export function makeLocation(
  overrides: Partial<ForecastLocation> = {},
): ForecastLocation {
  return {
    id: 'horsens',
    forecastConfigRevision: 1,
    name: 'Horsens',
    areaName: 'Horsens Fjord',
    subtitle: 'Horsens Fjord',
    timezone: 'Europe/Copenhagen',
    coordinate: { longitude: 9.85, latitude: 55.86 },
    dmiCollections: {
      water: ['dkss_idw', 'dkss_nsbs'],
      waves: ['wam_nsb', 'wam_dw'],
    },
    windSectors: [{
      id: 'east',
      label: 'Easterly',
      description: 'Test sector',
      exposure: 'onshore',
      min: 45,
      max: 135,
      safeLimit: 6,
      cautionLimit: 9,
    }],
    ...overrides,
  };
}

export function makeCacheHealth(
  overrides: Partial<WorkerCacheHealth> = {},
): WorkerCacheHealth {
  return {
    status: 'stale',
    lastAttemptAt: DEFAULT_TIMESTAMP,
    ...overrides,
  };
}

export function makeHeartbeat(
  overrides: Partial<CronHeartbeat> = {},
): CronHeartbeat {
  return {
    schemaVersion: 2,
    lastTickAt: DEFAULT_TIMESTAMP,
    locations: {},
    unreachable: {},
    ...overrides,
  };
}

interface TestKvCallbacks {
  get?: (key: string, type?: string) => Promise<unknown>;
  put?: (key: string, value: string, options?: KVNamespacePutOptions) => Promise<void>;
  delete?: (key: string) => Promise<void>;
}

export function makeTestKvNamespace(
  callbacks: TestKvCallbacks = {},
): KVNamespace {
  const read = async (
    key: string,
    typeOrOptions?: string | KVNamespaceGetOptions<unknown>,
  ): Promise<unknown> => {
    const type = typeof typeOrOptions === 'string'
      ? typeOrOptions
      : typeof typeOrOptions?.type === 'string'
        ? typeOrOptions.type
        : undefined;
    return callbacks.get ? callbacks.get(key, type) : null;
  };
  const get = async (
    key: string | string[],
    typeOrOptions?: string | KVNamespaceGetOptions<unknown>,
  ): Promise<any> => Array.isArray(key)
    ? new Map(await Promise.all(key.map(async (item) => [
        item,
        await read(item, typeOrOptions),
      ] as const)))
    : read(key, typeOrOptions);
  const getWithMetadata = async (
    key: string | string[],
    typeOrOptions?: string | KVNamespaceGetOptions<unknown>,
  ): Promise<any> => {
    if (Array.isArray(key)) {
      return new Map(await Promise.all(key.map(async (item) => [
        item,
        {
          value: await read(item, typeOrOptions),
          metadata: null,
          cacheStatus: null,
        },
      ] as const)));
    }
    return {
      value: await read(key, typeOrOptions),
      metadata: null,
      cacheStatus: null,
    };
  };
  return {
    get: get as KVNamespace['get'],
    async put(key, value, options): Promise<void> {
      if (typeof value !== 'string') {
        throw new TypeError('Worker tests only support string KV values.');
      }
      await callbacks.put?.(key, value, options);
    },
    async list(): Promise<any> {
      return { list_complete: true, keys: [], cacheStatus: null };
    },
    getWithMetadata: getWithMetadata as KVNamespace['getWithMetadata'],
    async delete(key): Promise<void> {
      await callbacks.delete?.(key);
    },
  };
}

export function makeTestEnv(
  cache: KVNamespace,
  overrides: Partial<Omit<Env, 'FRANK_FORECAST_CACHE'>> = {},
): Env {
  return {
    FRANK_FORECAST_CACHE: cache,
    CF_VERSION_METADATA: {
      id: '00000000-0000-0000-0000-000000000000',
      tag: 'test',
      timestamp: DEFAULT_TIMESTAMP,
    },
    FRANK_WARM_TOKEN: 'test-only-warm-token',
    ...overrides,
  };
}

class TestSpan {
  get isTraced(): boolean {
    return false;
  }

  setAttribute(): this {
    return this;
  }

  setAttributes(): this {
    return this;
  }

  end(): void {}
}

const testTracing: Tracing = {
  enterSpan<T, A extends unknown[]>(
    _name: string,
    callback: (span: Span, ...args: A) => T,
    ...args: A
  ): T {
    return callback(new TestSpan(), ...args);
  },
  startActiveSpan<T, A extends unknown[]>(
    _name: string,
    callback: (span: Span, ...args: A) => T,
    ...args: A
  ): T {
    return callback(new TestSpan(), ...args);
  },
  startSpan(): Span {
    return new TestSpan();
  },
  Span: TestSpan,
};

export function makeTestExecutionContext(
  onWaitUntil: (value: Promise<unknown>) => void,
): ExecutionContext {
  const exports = new Proxy<Cloudflare.Exports>(Object.create(null), {
    get(_target, property): never {
      throw new Error(`Unexpected ctx.exports access: ${String(property)}`);
    },
  });
  return {
    waitUntil: onWaitUntil,
    passThroughOnException(): void {},
    exports,
    props: undefined,
    tracing: testTracing,
    abort(reason?: unknown): never {
      throw reason instanceof Error
        ? reason
        : new Error(`Execution context aborted: ${String(reason ?? 'unknown reason')}`);
    },
  };
}
