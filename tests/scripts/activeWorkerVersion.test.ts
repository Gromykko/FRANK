// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { requireActiveWorkerVersion } from '../../scripts/active-worker-version.mjs';

const ACTIVE_ID = 'cba7bd5e-93f4-4df7-8b61-8f00d5b6f3a1';

describe('active Worker rollback target', () => {
  it('returns the single version serving all production traffic', () => {
    expect(requireActiveWorkerVersion({
      id: 'deployment-id',
      versions: [{ version_id: ACTIVE_ID, percentage: 100 }],
    })).toBe(ACTIVE_ID);
  });

  it.each([
    null,
    {},
    { versions: [] },
    { versions: [{ version_id: ACTIVE_ID, percentage: 90 }] },
    { versions: [
      { version_id: ACTIVE_ID, percentage: 100 },
      { version_id: 'b667d0b0-cb02-482d-b418-bfb56826ee0f', percentage: 100 },
    ] },
    { versions: [{ version_id: 'not-a-version', percentage: 100 }] },
  ])('fails closed when production has no unambiguous rollback target', (status) => {
    expect(() => requireActiveWorkerVersion(status)).toThrow(
      'Expected exactly one valid Worker version serving 100% of production traffic.',
    );
  });
});
