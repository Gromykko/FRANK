import { describe, it, expect } from 'vitest';
import { sectorMidBearing, compassPoint } from '../../src/utils/compass';

describe('sectorMidBearing', () => {
  it('is the plain midpoint for a normal arc', () => {
    expect(sectorMidBearing(45, 135)).toBe(90);
    expect(sectorMidBearing(225, 315)).toBe(270);
  });

  it('wraps through north when min > max', () => {
    expect(sectorMidBearing(315, 45)).toBe(0);   // NW->N->NE midpoint is due N
    expect(sectorMidBearing(350, 10)).toBe(0);
  });
});

describe('compassPoint', () => {
  it('names the nearest 8-point direction', () => {
    expect(compassPoint(0)).toBe('N');
    expect(compassPoint(90)).toBe('E');
    expect(compassPoint(180)).toBe('S');
    expect(compassPoint(270)).toBe('W');
    expect(compassPoint(45)).toBe('NE');
  });

  it('handles the 360 -> 0 wrap and negative bearings', () => {
    expect(compassPoint(360)).toBe('N');
    expect(compassPoint(338)).toBe('N'); // rounds up through 360 -> 0
    expect(compassPoint(-45)).toBe('NW');
  });
});
