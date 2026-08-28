import type { MetWeatherSeverity, MetWeatherSymbolBase } from './weatherSymbols';

export interface WeatherPolicyGroup {
  codes: readonly MetWeatherSymbolBase[];
  severity: MetWeatherSeverity;
  conditionLabel: string;
  policyNote: string;
}

// Human-readable groups for the manual. The tests compare this list with the
// complete MET registry, so adding or reclassifying a symbol cannot leave the
// manual behind. Day, night and polar-twilight suffixes change the artwork,
// not the result, and therefore share one row here.
export const WEATHER_POLICY_GROUPS: readonly WeatherPolicyGroup[] = [
  {
    codes: ['clearsky', 'fair', 'partlycloudy', 'cloudy'],
    severity: 'safe',
    conditionLabel: 'Clear sky, fair, partly cloudy, or cloudy',
    policyNote: 'This weather condition alone does not raise the result.',
  },
  {
    codes: ['lightrain'],
    severity: 'safe',
    conditionLabel: 'Light rain',
    policyNote: 'Light continuous rain alone does not raise the result.',
  },
  {
    codes: ['lightrainshowers', 'rainshowers'],
    severity: 'caution',
    conditionLabel: 'Light rain showers or rain showers',
    policyNote: 'Rain showers trigger Check before launch.',
  },
  {
    codes: ['rain'],
    severity: 'caution',
    conditionLabel: 'Rain',
    policyNote: 'Continuous rain triggers Check before launch.',
  },
  {
    codes: ['lightsleet', 'sleet', 'lightsnow', 'snow'],
    severity: 'caution',
    conditionLabel: 'Light or ordinary sleet or snow',
    policyNote: 'Continuous light or ordinary sleet and snow trigger Check before launch.',
  },
  {
    codes: ['fog'],
    severity: 'caution',
    conditionLabel: 'Fog',
    policyNote: 'Fog triggers Check before launch because visibility needs checking.',
  },
  {
    codes: ['heavyrainshowers', 'heavyrain'],
    severity: 'danger',
    conditionLabel: 'Heavy rain showers or heavy rain',
    policyNote: 'Heavy precipitation is Not recommended.',
  },
  {
    codes: [
      'lightsleetshowers', 'sleetshowers', 'heavysleetshowers',
      'lightsnowshowers', 'snowshowers', 'heavysnowshowers',
    ],
    severity: 'danger',
    conditionLabel: 'Light, ordinary, or heavy sleet or snow showers',
    policyNote: 'Every sleet or snow shower is Not recommended, including those MET labels light.',
  },
  {
    codes: ['heavysleet', 'heavysnow'],
    severity: 'danger',
    conditionLabel: 'Heavy sleet or heavy snow',
    policyNote: 'Heavy precipitation is Not recommended.',
  },
  {
    codes: [
      'lightrainshowersandthunder', 'rainshowersandthunder', 'heavyrainshowersandthunder',
      'lightssleetshowersandthunder', 'sleetshowersandthunder', 'heavysleetshowersandthunder',
      'lightssnowshowersandthunder', 'snowshowersandthunder', 'heavysnowshowersandthunder',
      'lightrainandthunder', 'rainandthunder', 'heavyrainandthunder',
      'lightsleetandthunder', 'sleetandthunder', 'heavysleetandthunder',
      'lightsnowandthunder', 'snowandthunder', 'heavysnowandthunder',
    ],
    severity: 'danger',
    conditionLabel: 'Any rain, sleet, or snow condition with thunder',
    policyNote: 'Every thunder condition is Not recommended.',
  },
] as const;
