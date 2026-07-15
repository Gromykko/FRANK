const WEATHER_CODE_DESCRIPTIONS: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snow fall',
  73: 'Moderate snow fall',
  75: 'Heavy snow fall',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm risk',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

export function getWeatherDescription(code: number): string {
  return WEATHER_CODE_DESCRIPTIONS[code] || 'Unknown weather';
}

// MET Norway Locationforecast reports the condition as a symbol_code string
// (e.g. "clearsky_day", "lightrainshowers_night", "heavyrainandthunder"). MET
// already decides the weather symbol; FRANK only maps it onto the WMO code
// our existing icons and descriptions consume — no custom weather derivation.
const MET_SYMBOL_TO_WMO: Record<string, number> = {
  clearsky: 0,
  fair: 1,
  partlycloudy: 2,
  cloudy: 3,
  fog: 45,
  lightrain: 61,
  rain: 63,
  heavyrain: 65,
  lightrainshowers: 80,
  rainshowers: 81,
  heavyrainshowers: 82,
  lightsleet: 66,
  sleet: 66,
  heavysleet: 67,
  lightsleetshowers: 66,
  sleetshowers: 66,
  heavysleetshowers: 67,
  lightsnow: 71,
  snow: 73,
  heavysnow: 75,
  lightsnowshowers: 85,
  snowshowers: 85,
  heavysnowshowers: 86,
};

export function metSymbolToWmoCode(symbol: string | undefined): number {
  if (!symbol) return 3;
  const base = symbol.replace(/_(day|night|polartwilight)$/, '');
  // Every "...andthunder" variant maps onto the WMO thunderstorm family.
  if (base.includes('thunder')) return base.includes('heavy') ? 99 : 95;
  return MET_SYMBOL_TO_WMO[base] ?? 3;
}
