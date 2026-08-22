import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import {
  KV_WRITE_CATEGORIES,
  putKvWithLog,
} from '../../worker/kvWriteLogging';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('KV write logging', () => {
  it('logs the category only after the KV write resolves', async () => {
    let resolveWrite: (() => void) | undefined;
    const put = vi.fn(() => new Promise<void>((resolve) => {
      resolveWrite = resolve;
    }));
    const namespace = { put } as Pick<KVNamespace, 'put'>;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const pending = putKvWithLog(
      namespace,
      'forecast-key',
      'forecast-value',
      'assembled-forecast',
      'horsens',
    );

    expect(put).toHaveBeenCalledWith('forecast-key', 'forecast-value');
    expect(log).not.toHaveBeenCalled();

    resolveWrite?.();
    await pending;

    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      '{"event":"kv_write","category":"assembled-forecast","locationId":"horsens"}',
    );
  });

  it('does not log a rejected KV write as successful', async () => {
    const failure = new Error('KV write failed');
    const namespace = {
      put: vi.fn(async () => {
        throw failure;
      }),
    } as Pick<KVNamespace, 'put'>;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(putKvWithLog(
      namespace,
      'heartbeat-key',
      'heartbeat-value',
      'heartbeat-cadence',
    )).rejects.toBe(failure);

    expect(log).not.toHaveBeenCalled();
  });

  it('centralizes every Worker KV put and wires every category', async () => {
    const workerFiles = (await readdir('worker'))
      .filter((file) => file.endsWith('.ts'))
      .sort();
    const sources = await Promise.all(workerFiles.map(async (file) => ({
      file,
      source: await readFile(`worker/${file}`, 'utf8'),
    })));
    const filesWithDirectPuts = sources
      .filter(({ source }) => /\.put\s*\(/.test(source))
      .map(({ file }) => file);

    expect(filesWithDirectPuts).toEqual(['kvWriteLogging.ts']);

    const callSiteSource = sources
      .filter(({ file }) => file !== 'kvWriteLogging.ts')
      .map(({ source }) => source)
      .join('\n');
    for (const category of KV_WRITE_CATEGORIES) {
      expect(callSiteSource).toContain(`'${category}'`);
    }
  });
});
