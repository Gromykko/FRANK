export type MetWeatherSeverity = 'safe' | 'caution' | 'danger';

export type MetWeatherIconKind =
  | 'clear'
  | 'fair'
  | 'partly-cloudy'
  | 'cloudy'
  | 'fog'
  | 'rain'
  | 'sleet'
  | 'snow'
  | 'thunder';

interface MetWeatherSymbolDefinition {
  /** Official MET Weathericons English legend text. */
  description: string;
  /** FRANK's approximate Lucide icon family, not a MET classification. */
  icon: MetWeatherIconKind;
  /** FRANK's paddling policy, not a safety judgement made by MET. */
  severity: MetWeatherSeverity;
  /** Official MET phase-variant availability. */
  variants: boolean;
}

// MET Locationforecast's `symbol_code` is the condition contract. English is
// copied verbatim from MET Weathericons' official legend; `variants` records
// whether MET may append _day, _night or _polartwilight. The icon and severity
// columns are explicitly FRANK-owned presentation/safety policy.
//
// Sources:
// https://raw.githubusercontent.com/metno/weathericons/main/weather/legend.csv
// https://api.met.no/weatherapi/locationforecast/2.0/documentation
//
// MET deliberately retains the double-s spellings
// `lightssleetshowersandthunder` and `lightssnowshowersandthunder` for API
// compatibility. Do not “correct” them until MET ships a new contract.
export const MET_WEATHER_SYMBOLS = Object.freeze({
  clearsky: { description: 'Clear sky', icon: 'clear', severity: 'safe', variants: true },
  fair: { description: 'Fair', icon: 'fair', severity: 'safe', variants: true },
  partlycloudy: { description: 'Partly cloudy', icon: 'partly-cloudy', severity: 'safe', variants: true },
  cloudy: { description: 'Cloudy', icon: 'cloudy', severity: 'safe', variants: false },

  lightrainshowers: { description: 'Light rain showers', icon: 'rain', severity: 'caution', variants: true },
  rainshowers: { description: 'Rain showers', icon: 'rain', severity: 'caution', variants: true },
  heavyrainshowers: { description: 'Heavy rain showers', icon: 'rain', severity: 'danger', variants: true },
  lightrainshowersandthunder: { description: 'Light rain showers and thunder', icon: 'thunder', severity: 'danger', variants: true },
  rainshowersandthunder: { description: 'Rain showers and thunder', icon: 'thunder', severity: 'danger', variants: true },
  heavyrainshowersandthunder: { description: 'Heavy rain showers and thunder', icon: 'thunder', severity: 'danger', variants: true },

  lightsleetshowers: { description: 'Light sleet showers', icon: 'sleet', severity: 'danger', variants: true },
  sleetshowers: { description: 'Sleet showers', icon: 'sleet', severity: 'danger', variants: true },
  heavysleetshowers: { description: 'Heavy sleet showers', icon: 'sleet', severity: 'danger', variants: true },
  lightssleetshowersandthunder: { description: 'Light sleet showers and thunder', icon: 'thunder', severity: 'danger', variants: true },
  sleetshowersandthunder: { description: 'Sleet showers and thunder', icon: 'thunder', severity: 'danger', variants: true },
  heavysleetshowersandthunder: { description: 'Heavy sleet showers and thunder', icon: 'thunder', severity: 'danger', variants: true },

  lightsnowshowers: { description: 'Light snow showers', icon: 'snow', severity: 'danger', variants: true },
  snowshowers: { description: 'Snow showers', icon: 'snow', severity: 'danger', variants: true },
  heavysnowshowers: { description: 'Heavy snow showers', icon: 'snow', severity: 'danger', variants: true },
  lightssnowshowersandthunder: { description: 'Light snow showers and thunder', icon: 'thunder', severity: 'danger', variants: true },
  snowshowersandthunder: { description: 'Snow showers and thunder', icon: 'thunder', severity: 'danger', variants: true },
  heavysnowshowersandthunder: { description: 'Heavy snow showers and thunder', icon: 'thunder', severity: 'danger', variants: true },

  lightrain: { description: 'Light rain', icon: 'rain', severity: 'safe', variants: false },
  rain: { description: 'Rain', icon: 'rain', severity: 'caution', variants: false },
  heavyrain: { description: 'Heavy rain', icon: 'rain', severity: 'danger', variants: false },
  lightrainandthunder: { description: 'Light rain and thunder', icon: 'thunder', severity: 'danger', variants: false },
  rainandthunder: { description: 'Rain and thunder', icon: 'thunder', severity: 'danger', variants: false },
  heavyrainandthunder: { description: 'Heavy rain and thunder', icon: 'thunder', severity: 'danger', variants: false },

  lightsleet: { description: 'Light sleet', icon: 'sleet', severity: 'caution', variants: false },
  sleet: { description: 'Sleet', icon: 'sleet', severity: 'caution', variants: false },
  heavysleet: { description: 'Heavy sleet', icon: 'sleet', severity: 'danger', variants: false },
  lightsleetandthunder: { description: 'Light sleet and thunder', icon: 'thunder', severity: 'danger', variants: false },
  sleetandthunder: { description: 'Sleet and thunder', icon: 'thunder', severity: 'danger', variants: false },
  heavysleetandthunder: { description: 'Heavy sleet and thunder', icon: 'thunder', severity: 'danger', variants: false },

  lightsnow: { description: 'Light snow', icon: 'snow', severity: 'caution', variants: false },
  snow: { description: 'Snow', icon: 'snow', severity: 'caution', variants: false },
  heavysnow: { description: 'Heavy snow', icon: 'snow', severity: 'danger', variants: false },
  lightsnowandthunder: { description: 'Light snow and thunder', icon: 'thunder', severity: 'danger', variants: false },
  snowandthunder: { description: 'Snow and thunder', icon: 'thunder', severity: 'danger', variants: false },
  heavysnowandthunder: { description: 'Heavy snow and thunder', icon: 'thunder', severity: 'danger', variants: false },

  fog: { description: 'Fog', icon: 'fog', severity: 'caution', variants: false },
} as const satisfies Record<string, MetWeatherSymbolDefinition>);

export type MetWeatherSymbolBase = keyof typeof MET_WEATHER_SYMBOLS;
export type MetWeatherSymbolVariant = 'day' | 'night' | 'polartwilight';

const MET_VARIANT_SUFFIX = /_(day|night|polartwilight)$/;

function hasMetWeatherSymbol(base: string): base is MetWeatherSymbolBase {
  return Object.prototype.hasOwnProperty.call(MET_WEATHER_SYMBOLS, base);
}

export function getMetWeatherSymbolBase(symbol: unknown): MetWeatherSymbolBase | null {
  if (typeof symbol !== 'string' || !symbol) return null;
  const variant = symbol.match(MET_VARIANT_SUFFIX)?.[1];
  const base = symbol.replace(MET_VARIANT_SUFFIX, '');
  if (!hasMetWeatherSymbol(base)) return null;
  // The live API has 83 concrete values: the 21 artwork-varying conditions
  // always carry a phase suffix, while the other 20 are always unsuffixed.
  // Enforcing that shape stops plausible-looking but non-contract spellings
  // such as `fog_night` or bare `snowshowers` from being called known weather.
  return MET_WEATHER_SYMBOLS[base].variants === Boolean(variant) ? base : null;
}

export function getMetWeatherSymbolVariant(symbol: unknown): MetWeatherSymbolVariant | null {
  if (typeof symbol !== 'string' || !getMetWeatherSymbolBase(symbol)) return null;
  const match = symbol.match(MET_VARIANT_SUFFIX);
  return (match?.[1] as MetWeatherSymbolVariant | undefined) ?? null;
}

export function isKnownMetWeatherSymbol(symbol: unknown): boolean {
  return getMetWeatherSymbolBase(symbol) !== null;
}

export function getMetWeatherDescription(symbol: unknown): string {
  const base = getMetWeatherSymbolBase(symbol);
  return base ? MET_WEATHER_SYMBOLS[base].description : 'Unknown weather';
}

export function getMetWeatherIconKind(symbol: unknown): MetWeatherIconKind | 'unknown' {
  const base = getMetWeatherSymbolBase(symbol);
  return base ? MET_WEATHER_SYMBOLS[base].icon : 'unknown';
}

export function getMetWeatherSeverity(symbol: unknown): MetWeatherSeverity | null {
  const base = getMetWeatherSymbolBase(symbol);
  return base ? MET_WEATHER_SYMBOLS[base].severity : null;
}
