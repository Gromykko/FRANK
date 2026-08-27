import { describe, expect, it } from 'vitest';
import { da } from '../../../src/i18n/da';
import {
  getMetWeatherDescription,
  getMetWeatherIconKind,
  getMetWeatherSeverity,
  getMetWeatherSymbolBase,
  getMetWeatherSymbolVariant,
  isKnownMetWeatherSymbol,
  MET_WEATHER_SYMBOLS,
} from '../../../src/features/forecast/weatherSymbols';
import type { MetWeatherSeverity } from '../../../src/features/forecast/weatherSymbols';

// Each row pins official MET base/English/variant data alongside FRANK-owned
// Danish and severity policy. The latter two are deliberately not attributed
// to MET.
const EXPECTED_SYMBOL_POLICY = [
  ['clearsky', 'Clear sky', 'Klart vejr', 'safe', true],
  ['fair', 'Fair', 'Let skyet', 'safe', true],
  ['partlycloudy', 'Partly cloudy', 'Delvist skyet', 'safe', true],
  ['cloudy', 'Cloudy', 'Skyet', 'safe', false],
  ['lightrainshowers', 'Light rain showers', 'Lette regnbyger', 'caution', true],
  ['rainshowers', 'Rain showers', 'Regnbyger', 'caution', true],
  ['heavyrainshowers', 'Heavy rain showers', 'Kraftige regnbyger', 'danger', true],
  ['lightrainshowersandthunder', 'Light rain showers and thunder', 'Lette regnbyger med torden', 'danger', true],
  ['rainshowersandthunder', 'Rain showers and thunder', 'Regnbyger med torden', 'danger', true],
  ['heavyrainshowersandthunder', 'Heavy rain showers and thunder', 'Kraftige regnbyger med torden', 'danger', true],
  ['lightsleetshowers', 'Light sleet showers', 'Lette sludbyger', 'danger', true],
  ['sleetshowers', 'Sleet showers', 'Sludbyger', 'danger', true],
  ['heavysleetshowers', 'Heavy sleet showers', 'Kraftige sludbyger', 'danger', true],
  ['lightssleetshowersandthunder', 'Light sleet showers and thunder', 'Lette sludbyger med torden', 'danger', true],
  ['sleetshowersandthunder', 'Sleet showers and thunder', 'Sludbyger med torden', 'danger', true],
  ['heavysleetshowersandthunder', 'Heavy sleet showers and thunder', 'Kraftige sludbyger med torden', 'danger', true],
  ['lightsnowshowers', 'Light snow showers', 'Lette snebyger', 'danger', true],
  ['snowshowers', 'Snow showers', 'Snebyger', 'danger', true],
  ['heavysnowshowers', 'Heavy snow showers', 'Kraftige snebyger', 'danger', true],
  ['lightssnowshowersandthunder', 'Light snow showers and thunder', 'Lette snebyger med torden', 'danger', true],
  ['snowshowersandthunder', 'Snow showers and thunder', 'Snebyger med torden', 'danger', true],
  ['heavysnowshowersandthunder', 'Heavy snow showers and thunder', 'Kraftige snebyger med torden', 'danger', true],
  ['lightrain', 'Light rain', 'Let regn', 'safe', false],
  ['rain', 'Rain', 'Regn', 'caution', false],
  ['heavyrain', 'Heavy rain', 'Kraftig regn', 'danger', false],
  ['lightrainandthunder', 'Light rain and thunder', 'Let regn med torden', 'danger', false],
  ['rainandthunder', 'Rain and thunder', 'Regn med torden', 'danger', false],
  ['heavyrainandthunder', 'Heavy rain and thunder', 'Kraftig regn med torden', 'danger', false],
  ['lightsleet', 'Light sleet', 'Let slud', 'caution', false],
  ['sleet', 'Sleet', 'Slud', 'caution', false],
  ['heavysleet', 'Heavy sleet', 'Kraftig slud', 'danger', false],
  ['lightsleetandthunder', 'Light sleet and thunder', 'Let slud med torden', 'danger', false],
  ['sleetandthunder', 'Sleet and thunder', 'Slud med torden', 'danger', false],
  ['heavysleetandthunder', 'Heavy sleet and thunder', 'Kraftig slud med torden', 'danger', false],
  ['lightsnow', 'Light snow', 'Let sne', 'caution', false],
  ['snow', 'Snow', 'Sne', 'caution', false],
  ['heavysnow', 'Heavy snow', 'Kraftig sne', 'danger', false],
  ['lightsnowandthunder', 'Light snow and thunder', 'Let sne med torden', 'danger', false],
  ['snowandthunder', 'Snow and thunder', 'Sne med torden', 'danger', false],
  ['heavysnowandthunder', 'Heavy snow and thunder', 'Kraftig sne med torden', 'danger', false],
  ['fog', 'Fog', 'Tåge', 'caution', false],
] as const satisfies readonly (readonly [string, string, string, MetWeatherSeverity, boolean])[];

interface ConcreteExpectedSymbol {
  symbol: string;
  base: keyof typeof MET_WEATHER_SYMBOLS;
  english: string;
  severity: MetWeatherSeverity;
  phase: 'day' | 'night' | 'polartwilight' | null;
}

describe('MET Weathericons vocabulary', () => {
  it('matches all 41 official base symbols and their exact English labels', () => {
    expect(EXPECTED_SYMBOL_POLICY).toHaveLength(41);
    expect(Object.keys(MET_WEATHER_SYMBOLS)).toEqual(EXPECTED_SYMBOL_POLICY.map(([base]) => base));

    for (const [base, english, danish, severity, variants] of EXPECTED_SYMBOL_POLICY) {
      const definition = MET_WEATHER_SYMBOLS[base as keyof typeof MET_WEATHER_SYMBOLS];
      expect(definition.description, base).toBe(english);
      expect(definition.severity, base).toBe(severity);
      expect(definition.variants, base).toBe(variants);
      expect(da[english], base).toBe(danish);
    }
  });

  it('recognises exactly the 83 concrete Locationforecast symbol values', () => {
    const phases = ['day', 'night', 'polartwilight'] as const;
    const concrete = EXPECTED_SYMBOL_POLICY.flatMap<ConcreteExpectedSymbol>(([
      base,
      english,
      ,
      severity,
      variants,
    ]) =>
      variants
        ? phases.map((phase): ConcreteExpectedSymbol => ({
            symbol: `${base}_${phase}`,
            base,
            english,
            severity,
            phase,
          }))
        : [{ symbol: base, base, english, severity, phase: null }]);

    expect(concrete).toHaveLength(83);
    for (const { symbol, base, english, severity, phase } of concrete) {
      expect(isKnownMetWeatherSymbol(symbol), symbol).toBe(true);
      expect(getMetWeatherSymbolBase(symbol), symbol).toBe(base);
      expect(getMetWeatherSymbolVariant(symbol), symbol).toBe(phase);
      expect(getMetWeatherDescription(symbol), symbol).toBe(english);
      expect(getMetWeatherIconKind(symbol), symbol).not.toBe('unknown');
      expect(getMetWeatherSeverity(symbol), symbol).toBe(severity);
    }
  });

  it('pins FRANK’s icon family for every official base symbol', () => {
    const expectedGroups = {
      clear: ['clearsky'],
      fair: ['fair'],
      'partly-cloudy': ['partlycloudy'],
      cloudy: ['cloudy'],
      fog: ['fog'],
      rain: ['lightrainshowers', 'rainshowers', 'heavyrainshowers', 'lightrain', 'rain', 'heavyrain'],
      sleet: ['lightsleetshowers', 'sleetshowers', 'heavysleetshowers', 'lightsleet', 'sleet', 'heavysleet'],
      snow: ['lightsnowshowers', 'snowshowers', 'heavysnowshowers', 'lightsnow', 'snow', 'heavysnow'],
      thunder: [
        'lightrainshowersandthunder', 'rainshowersandthunder', 'heavyrainshowersandthunder',
        'lightssleetshowersandthunder', 'sleetshowersandthunder', 'heavysleetshowersandthunder',
        'lightssnowshowersandthunder', 'snowshowersandthunder', 'heavysnowshowersandthunder',
        'lightrainandthunder', 'rainandthunder', 'heavyrainandthunder',
        'lightsleetandthunder', 'sleetandthunder', 'heavysleetandthunder',
        'lightsnowandthunder', 'snowandthunder', 'heavysnowandthunder',
      ],
    } as const;

    const covered = new Set<string>();
    for (const [icon, bases] of Object.entries(expectedGroups)) {
      for (const base of bases) {
        expect(MET_WEATHER_SYMBOLS[base].icon, base).toBe(icon);
        expect(covered.has(base), base).toBe(false);
        covered.add(base);
      }
    }
    expect([...covered]).toHaveLength(41);
  });

  it('preserves MET’s intentional double-s compatibility spellings', () => {
    expect(getMetWeatherDescription('lightssleetshowersandthunder_day'))
      .toBe('Light sleet showers and thunder');
    expect(getMetWeatherDescription('lightssnowshowersandthunder_night'))
      .toBe('Light snow showers and thunder');
    expect(isKnownMetWeatherSymbol('lightsleetshowersandthunder_day')).toBe(false);
    expect(isKnownMetWeatherSymbol('lightsnowshowersandthunder_night')).toBe(false);
  });

  it('rejects invalid phase shapes and unknown/malformed provider values', () => {
    for (const invalid of [
      'clearsky',
      'snowshowers',
      'fog_night',
      'rain_day',
      'clearsky_dawn',
      'someunknownsymbol',
      '',
      undefined,
      42,
      {},
    ]) {
      expect(getMetWeatherSymbolBase(invalid), String(invalid)).toBeNull();
      expect(getMetWeatherDescription(invalid), String(invalid)).toBe('Unknown weather');
      expect(getMetWeatherIconKind(invalid), String(invalid)).toBe('unknown');
      expect(getMetWeatherSeverity(invalid), String(invalid)).toBeNull();
      expect(getMetWeatherSymbolVariant(invalid), String(invalid)).toBeNull();
    }
  });

  it('reads phase from symbol_code rather than recomputing it', () => {
    expect(getMetWeatherSymbolVariant('fair_day')).toBe('day');
    expect(getMetWeatherSymbolVariant('fair_night')).toBe('night');
    expect(getMetWeatherSymbolVariant('fair_polartwilight')).toBe('polartwilight');
    expect(getMetWeatherSymbolVariant('rain')).toBeNull();
  });
});
