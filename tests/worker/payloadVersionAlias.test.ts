import { describe, expect, it } from 'vitest';
import { FORECAST_PAYLOAD_VERSION } from '../../src/features/forecast/types';
import { PAYLOAD_VERSION as CANONICAL } from '../../worker/forecastModel';
import { PAYLOAD_VERSION as VIA_ALIAS } from '../../worker/providers';

// worker/providers re-exports the generation-owned constant as a compatibility
// alias. Import through the alias rather than reading the file: a substring
// match on the export block passes even when the alias points somewhere else,
// which is the exact failure this test exists to catch.
describe('the Worker payload-version alias', () => {
  it('resolves to the one shared constant', () => {
    expect(VIA_ALIAS).toBe(CANONICAL);
    expect(VIA_ALIAS).toBe(FORECAST_PAYLOAD_VERSION);
  });
});
