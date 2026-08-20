import { describe, expect, it } from 'vitest';
import { assessBlockDaylight } from '../../../src/features/safety/blockDaylight';

const hour = (iso: string) => Date.parse(iso);
const sun = {
  sunrise: ['2026-10-04T08:00:00Z'],
  sunset: ['2026-10-04T20:00:00Z'],
};

describe('assessBlockDaylight', () => {
  it('classifies a period whose every complete slot is daylight as full', () => {
    expect(assessBlockDaylight(
      hour('2026-10-04T09:00:00Z'),
      hour('2026-10-04T15:00:00Z'),
      sun,
    )).toEqual({
      status: 'full',
      fullHours: 6,
      sliceHours: 6,
      sliceStartMs: hour('2026-10-04T09:00:00Z'),
      sliceEndMs: hour('2026-10-04T15:00:00Z'),
    });
  });

  it('classifies and clips a partly-daylit period', () => {
    expect(assessBlockDaylight(
      hour('2026-10-04T06:00:00Z'),
      hour('2026-10-04T12:00:00Z'),
      sun,
    )).toEqual({
      status: 'partial',
      fullHours: 4,
      sliceHours: 4,
      sliceStartMs: hour('2026-10-04T08:00:00Z'),
      sliceEndMs: hour('2026-10-04T12:00:00Z'),
    });
  });

  it('distinguishes known night from an unknown sun schedule', () => {
    expect(assessBlockDaylight(
      hour('2026-10-04T00:00:00Z'),
      hour('2026-10-04T06:00:00Z'),
      sun,
    )).toEqual({ status: 'none', fullHours: 0, sliceHours: 0, sliceStartMs: null, sliceEndMs: null });

    expect(assessBlockDaylight(
      hour('2026-10-04T00:00:00Z'),
      hour('2026-10-04T06:00:00Z'),
      undefined,
    )).toEqual({ status: 'unknown', fullHours: 0, sliceHours: 0, sliceStartMs: null, sliceEndMs: null });
  });

  it('never counts an hour that crosses sunset', () => {
    const sunsetAt1859 = {
      sunrise: ['2026-10-04T08:00:00Z'],
      sunset: ['2026-10-04T18:59:00Z'],
    };
    const result = assessBlockDaylight(
      hour('2026-10-04T14:00:00Z'),
      hour('2026-10-04T20:00:00Z'),
      sunsetAt1859,
    );

    expect(result).toMatchObject({ status: 'partial', fullHours: 4, sliceHours: 4 });
    expect(result.sliceEndMs).toBe(hour('2026-10-04T18:00:00Z'));
  });

  it('never joins daylight on opposite sides of an overnight gap', () => {
    const twoDays = {
      sunrise: ['2026-10-04T06:00:00Z', '2026-10-05T06:00:00Z'],
      sunset: ['2026-10-04T18:00:00Z', '2026-10-05T18:00:00Z'],
    };
    const result = assessBlockDaylight(
      hour('2026-10-04T16:00:00Z'),
      hour('2026-10-05T08:00:00Z'),
      twoDays,
    );

    expect(result).toEqual({
      status: 'partial',
      fullHours: 4,
      sliceHours: 2,
      sliceStartMs: hour('2026-10-04T16:00:00Z'),
      sliceEndMs: hour('2026-10-04T18:00:00Z'),
    });
  });
});
