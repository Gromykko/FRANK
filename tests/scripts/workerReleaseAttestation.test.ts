// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  COORDINATED_BASELINE_MARKER_KEY,
  attestCapturedWorkerRelease,
  classifyCapturedWorkerRelease,
  decodeReleaseAttestation,
  encodeReleaseAttestation,
  probeCapturedWorkerRelease,
  remoteBaselineMarkerExists,
  writeRemoteBaselineMarker,
} from '../../scripts/worker-release-attestation.mjs';

const VERSION_ID = 'b667d0b0-cb02-482d-b418-bfb56826ee0f';
const CURRENT = Object.freeze({
  apiSchemaVersion: 1,
  modelRevision: 8,
  dataGenerationId: 'api1-model8',
  assembledCacheSchema: 2,
  marineCacheSchema: 1,
  payloadVersion: 7,
});
const PREVIOUS = Object.freeze({
  ...CURRENT,
  modelRevision: 7,
  dataGenerationId: 'api1-model7',
  assembledCacheSchema: 1,
});

function releaseHeaders(release = CURRENT) {
  return {
    'X-FRANK-API-Schema': String(release.apiSchemaVersion),
    'X-FRANK-Model-Revision': String(release.modelRevision),
    'X-FRANK-Data-Generation': release.dataGenerationId,
    'X-FRANK-Assembled-Cache-Schema': String(release.assembledCacheSchema),
    'X-FRANK-Marine-Cache-Schema': String(release.marineCacheSchema),
    'X-FRANK-Payload-Version': String(release.payloadVersion),
    'X-FRANK-Worker-Version': VERSION_ID,
  };
}

function rootResponse(release = CURRENT, headers = releaseHeaders(release)) {
  return new Response(JSON.stringify({
    ok: true,
    service: 'frank-forecast',
    release: { ...release, metRawCacheSchemaVersion: 1 },
  }), { status: 200, headers });
}

describe('captured Worker release attestation', () => {
  it('probes the immutable captured version and requires matching body, headers, and version', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(rootResponse());

    await expect(probeCapturedWorkerRelease({
      baseUrl: 'https://frank.example/',
      workerName: 'frank-forecast',
      expectedWorkerVersionId: VERSION_ID,
      fetchImpl,
    })).resolves.toEqual(CURRENT);

    const request = fetchImpl.mock.calls[0];
    expect(String(request[0])).toBe('https://frank.example/');
    expect(request[1].headers).toEqual({
      'Cloudflare-Workers-Version-Overrides': `frank-forecast="${VERSION_ID}"`,
    });
    expect(request[1].cache).toBe('no-store');
  });

  it('fails closed for partial, contradictory, or wrong-version release evidence', async () => {
    const wrongBody = { ...CURRENT, dataGenerationId: 'api1-model8-other' };
    await expect(probeCapturedWorkerRelease({
      baseUrl: 'https://frank.example/',
      workerName: 'frank-forecast',
      expectedWorkerVersionId: VERSION_ID,
      fetchImpl: vi.fn().mockResolvedValue(rootResponse(wrongBody, releaseHeaders(CURRENT))),
    })).rejects.toThrow('body and release headers disagree');

    const partialHeaders = new Headers({
      'X-FRANK-API-Schema': '1',
      'X-FRANK-Worker-Version': VERSION_ID,
    });
    await expect(probeCapturedWorkerRelease({
      baseUrl: 'https://frank.example/',
      workerName: 'frank-forecast',
      expectedWorkerVersionId: VERSION_ID,
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        service: 'frank-forecast',
      }), { status: 200, headers: partialHeaders })),
    })).rejects.toThrow('incomplete release headers');

    const wrongVersionHeaders = releaseHeaders(CURRENT);
    wrongVersionHeaders['X-FRANK-Worker-Version'] =
      'cba7bd5e-93f4-4df7-8b61-8f00d5b6f3a1';
    await expect(probeCapturedWorkerRelease({
      baseUrl: 'https://frank.example/',
      workerName: 'frank-forecast',
      expectedWorkerVersionId: VERSION_ID,
      fetchImpl: vi.fn().mockResolvedValue(rootResponse(CURRENT, wrongVersionHeaders)),
    })).rejects.toThrow('requested immutable version');
  });

  it('recognizes only clean pre-architecture absence as unproven', async () => {
    const legacy = new Response(JSON.stringify({
      ok: true,
      service: 'frank-forecast',
    }), { status: 200 });
    await expect(probeCapturedWorkerRelease({
      baseUrl: 'https://frank.example/',
      workerName: 'frank-forecast',
      expectedWorkerVersionId: VERSION_ID,
      fetchImpl: vi.fn().mockResolvedValue(legacy),
    })).resolves.toBeNull();
  });

  it('allows an unproven Worker only before the persistent baseline marker exists', () => {
    expect(classifyCapturedWorkerRelease({
      capturedRelease: null,
      currentRelease: CURRENT,
      auditedPreviousReleases: [],
      baselineEstablished: false,
    })).toEqual({
      mode: 'bootstrap-unproven',
      kvGcAllowed: false,
      releaseAttestation: '',
      baselineMarkerRequired: true,
    });

    expect(() => classifyCapturedWorkerRelease({
      capturedRelease: null,
      currentRelease: CURRENT,
      auditedPreviousReleases: [],
      baselineEstablished: true,
    })).toThrow('after the coordinated baseline was established');
  });

  it('accepts only current or the sole audited same-API N-1 descriptor', () => {
    const current = classifyCapturedWorkerRelease({
      capturedRelease: CURRENT,
      currentRelease: CURRENT,
      auditedPreviousReleases: [PREVIOUS],
      baselineEstablished: true,
    });
    expect(current.mode).toBe('verified-current');
    expect(decodeReleaseAttestation(current.releaseAttestation)).toEqual(CURRENT);

    const previous = classifyCapturedWorkerRelease({
      capturedRelease: PREVIOUS,
      currentRelease: CURRENT,
      auditedPreviousReleases: [PREVIOUS],
      baselineEstablished: false,
    });
    expect(previous).toMatchObject({
      mode: 'verified-n-1',
      kvGcAllowed: true,
      baselineMarkerRequired: true,
    });

    expect(() => classifyCapturedWorkerRelease({
      capturedRelease: { ...PREVIOUS, modelRevision: 6, dataGenerationId: 'api1-model6' },
      currentRelease: CURRENT,
      auditedPreviousReleases: [PREVIOUS],
      baselineEstablished: true,
    })).toThrow('neither CURRENT_RELEASE nor the audited N-1');
  });

  it('binds the full descriptor into a canonical GC-safe token', () => {
    const token = encodeReleaseAttestation(PREVIOUS);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeReleaseAttestation(token)).toEqual(PREVIOUS);
    expect(() => decodeReleaseAttestation(`${token}=`)).toThrow('malformed');
  });

  it('checks and writes the persistent production KV baseline marker remotely', async () => {
    const absentExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    await expect(remoteBaselineMarkerExists({ execFileImpl: absentExec }))
      .resolves.toBe(false);
    expect(absentExec.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'kv', 'key', 'list', '--remote', '--prefix', COORDINATED_BASELINE_MARKER_KEY,
    ]));

    const presentExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([{ name: COORDINATED_BASELINE_MARKER_KEY }]),
      stderr: '',
    });
    await expect(remoteBaselineMarkerExists({ execFileImpl: presentExec }))
      .resolves.toBe(true);

    const putExec = vi.fn().mockResolvedValue({ stdout: 'Success!', stderr: '' });
    await writeRemoteBaselineMarker(CURRENT, { execFileImpl: putExec });
    const putArgs = putExec.mock.calls[0][1] as string[];
    expect(putArgs).toEqual(expect.arrayContaining([
      'kv', 'key', 'put', COORDINATED_BASELINE_MARKER_KEY, '--remote',
    ]));
    expect(JSON.parse(putArgs[5])).toMatchObject({
      schemaVersion: 1,
      established: true,
      release: CURRENT,
    });
  });

  it('combines persistent marker state with the immutable version probe', async () => {
    const result = await attestCapturedWorkerRelease({
      contract: { release: CURRENT, auditedPreviousReleases: [PREVIOUS] },
      baseUrl: 'https://frank.example/',
      workerName: 'frank-forecast',
      expectedWorkerVersionId: VERSION_ID,
      markerExistsImpl: vi.fn().mockResolvedValue(true),
      fetchImpl: vi.fn().mockResolvedValue(rootResponse(PREVIOUS)),
    });
    expect(result).toMatchObject({
      mode: 'verified-n-1',
      kvGcAllowed: true,
      baselineMarkerRequired: false,
    });
  });
});
