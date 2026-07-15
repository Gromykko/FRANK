import { describe, it, expect } from 'vitest';
import {
  asNumber,
  normalizeDegrees,
  currentSpeedFromComponents,
  currentDirectionFromComponents,
} from '../../worker/index.js';

describe('worker pure math functions', () => {
  describe('asNumber', () => {
    it('returns number for valid inputs', () => {
      expect(asNumber(42)).toBe(42);
      expect(asNumber('42.5')).toBe(42.5);
      expect(asNumber('0')).toBe(0);
    });

    it('returns undefined for invalid inputs', () => {
      expect(asNumber(null)).toBeUndefined();
      expect(asNumber(undefined)).toBeUndefined();
      expect(asNumber('foo')).toBeUndefined();
      expect(asNumber(NaN)).toBeUndefined();
    });
  });

  describe('normalizeDegrees', () => {
    it('normalizes to 0-359', () => {
      expect(normalizeDegrees(0)).toBe(0);
      expect(normalizeDegrees(360)).toBe(0);
      expect(normalizeDegrees(-90)).toBe(270);
      expect(normalizeDegrees(450)).toBe(90);
      expect(normalizeDegrees(undefined)).toBeUndefined();
    });
  });

  describe('currentSpeedFromComponents', () => {
    it('calculates magnitude of vector', () => {
      expect(currentSpeedFromComponents(3, 4)).toBe(5);
      expect(currentSpeedFromComponents(0, 0)).toBe(0);
      expect(currentSpeedFromComponents(1, undefined)).toBeUndefined();
    });
  });

  describe('currentDirectionFromComponents', () => {
    it('calculates angle and normalizes to degrees', () => {
      // atan2(u, v) where u=x, v=y
      expect(currentDirectionFromComponents(0, 1)).toBe(0); // N
      expect(currentDirectionFromComponents(1, 0)).toBe(90); // E
      expect(currentDirectionFromComponents(0, -1)).toBe(180); // S
      expect(currentDirectionFromComponents(-1, 0)).toBe(270); // W
      expect(currentDirectionFromComponents(undefined, 1)).toBeUndefined();
    });
  });
});
