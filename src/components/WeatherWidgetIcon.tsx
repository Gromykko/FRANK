import { Sun, Cloud, CloudRain, CloudSnow, CloudLightning, CloudSun, CloudOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { getMetWeatherIconKind, getMetWeatherSymbolVariant } from '../features/forecast/weatherSymbols';

interface WeatherWidgetIconProps {
  symbolCode: string;
  suppressPhase?: boolean;
  size?: number;
}

interface IconSpec {
  animation: string;
  tone: string;
  icon: ReactNode;
}

function getIconSpec(symbolCode: string, isNight: boolean, size: number): IconSpec {
  const kind = getMetWeatherIconKind(symbolCode);
  if (kind === 'unknown') {
    return { animation: '', tone: 'tone-cloud', icon: <CloudOff size={size} /> };
  }
  if (isNight && kind === 'clear') {
    return {
      animation: 'moon-pulse',
      tone: 'tone-moon',
      icon: (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
        </svg>
      ),
    };
  }
  if (isNight && (kind === 'fair' || kind === 'partly-cloudy' || kind === 'cloudy')) {
    return { animation: 'cloud-drift', tone: 'tone-cloud', icon: <Cloud size={size} /> };
  }
  if (kind === 'clear') {
    return { animation: 'sun-spin', tone: 'tone-sun', icon: <Sun size={size} /> };
  }
  if (kind === 'fair' || kind === 'partly-cloudy') {
    return { animation: 'sun-cloud-drift', tone: 'tone-cloud', icon: <CloudSun size={size} /> };
  }
  if (kind === 'cloudy' || kind === 'fog') {
    return { animation: 'cloud-drift', tone: 'tone-cloud', icon: <Cloud size={size} /> };
  }
  if (kind === 'rain') {
    return { animation: 'rain-fall', tone: 'tone-rain', icon: <CloudRain size={size} /> };
  }
  if (kind === 'sleet' || kind === 'snow') {
    return { animation: 'snow-spin', tone: 'tone-snow', icon: <CloudSnow size={size} /> };
  }
  if (kind === 'thunder') {
    return { animation: 'lightning-flash', tone: 'tone-storm', icon: <CloudLightning size={size} /> };
  }
  // Exhaustive above, but retain a fail-closed visual if a future kind reaches
  // this component before its artwork is wired.
  return { animation: '', tone: 'tone-cloud', icon: <CloudOff size={size} /> };
}

export default function WeatherWidgetIcon({ symbolCode, suppressPhase = false, size = 32 }: WeatherWidgetIconProps) {
  // MET has already encoded the artwork phase in symbol_code. Do not
  // recalculate it from sunrise; that can disagree at the provider boundary.
  // Outlook symbols describe a whole period, so their start phase is suppressed.
  const isNight = !suppressPhase && getMetWeatherSymbolVariant(symbolCode) === 'night';
  const spec = getIconSpec(symbolCode, isNight, size);

  return (
    <div className="weather-widget-wrap" aria-hidden="true">
      <div className={`weather-widget-icon ${spec.animation} ${spec.tone}`}>{spec.icon}</div>
    </div>
  );
}
