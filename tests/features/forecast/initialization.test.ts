import { describe, expect, it } from 'vitest';
import { CURRENT_LOCATION } from '../../../src/config/locations';
import { parseForecastInitialization } from '../../../src/features/forecast/initialization';

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    status: 'initializing',
    code: 'FORECAST_INITIALIZING',
    message: 'Forecast is being initialized.',
    retryAfterSeconds: 600,
    location: {
      id: CURRENT_LOCATION.id,
      name: CURRENT_LOCATION.name,
      areaName: CURRENT_LOCATION.areaName,
    },
    ...overrides,
  };
}

function response(body: unknown, headers: HeadersInit = { 'Retry-After': '600' }) {
  return new Response(JSON.stringify(body), { status: 503, headers });
}

describe('forecast initialization response boundary', () => {
  it('accepts the versioned contract for the requested location and respects the longer retry instruction', async () => {
    const parsed = await parseForecastInitialization(
      response(envelope({ retryAfterSeconds: 120 }), { 'Retry-After': '600' }),
      CURRENT_LOCATION,
    );

    expect(parsed).toEqual({
      schemaVersion: 1,
      status: 'initializing',
      code: 'FORECAST_INITIALIZING',
      retryAfterSeconds: 600,
      location: {
        id: CURRENT_LOCATION.id,
        name: CURRENT_LOCATION.name,
        areaName: CURRENT_LOCATION.areaName,
      },
    });
  });

  it.each([
    ['wrong schema', { schemaVersion: 2 }],
    ['missing status', { status: undefined }],
    ['wrong status', { status: 'failed' }],
    ['generic code', { code: 'PROVIDER_BUSY' }],
    ['missing message', { message: undefined }],
    ['wrong location', { location: { id: 'vejle', name: 'Vejle', areaName: 'Vejle Fjord' } }],
    ['empty location name', { location: { id: CURRENT_LOCATION.id, name: '', areaName: CURRENT_LOCATION.areaName } }],
    ['invalid retry', { retryAfterSeconds: 0 }],
  ])('rejects %s instead of disguising it as initialization', async (_label, override) => {
    expect(await parseForecastInitialization(response(envelope(override)), CURRENT_LOCATION)).toBeNull();
  });

  it('rejects a non-503 response and malformed JSON', async () => {
    const ok = new Response(JSON.stringify(envelope()), { status: 200 });
    const malformed = new Response('{', { status: 503, headers: { 'Retry-After': '600' } });

    expect(await parseForecastInitialization(ok, CURRENT_LOCATION)).toBeNull();
    expect(await parseForecastInitialization(malformed, CURRENT_LOCATION)).toBeNull();
  });
});
