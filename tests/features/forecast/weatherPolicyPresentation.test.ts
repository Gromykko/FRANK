import { describe, expect, it } from 'vitest';
import { WEATHER_POLICY_GROUPS } from '../../../src/features/forecast/weatherPolicyPresentation';
import { MET_WEATHER_SYMBOLS } from '../../../src/features/forecast/weatherSymbols';

describe('weather policy manual groups', () => {
  it('covers every MET base condition exactly once with the live verdict severity', () => {
    const groupedCodes = WEATHER_POLICY_GROUPS.flatMap((group) => [...group.codes]);
    const registryCodes = Object.keys(MET_WEATHER_SYMBOLS);

    expect(new Set(groupedCodes).size).toBe(groupedCodes.length);
    expect([...groupedCodes].sort()).toEqual([...registryCodes].sort());

    for (const group of WEATHER_POLICY_GROUPS) {
      for (const code of group.codes) {
        expect(MET_WEATHER_SYMBOLS[code].severity).toBe(group.severity);
      }
    }
  });
});
