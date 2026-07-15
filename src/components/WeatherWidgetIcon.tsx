import { Sun, Cloud, CloudRain, CloudSnow, CloudLightning, CloudSun, CloudDrizzle } from 'lucide-react';
import type { ReactNode } from 'react';

interface WeatherWidgetIconProps {
  code: number;
  isNight: boolean;
  size?: number;
}

interface IconSpec {
  animation: string;
  tone: string;
  icon: ReactNode;
}

// WMO weather codes grouped into simplified states:
// 0-1 clear, 2-3 cloudy, 45/48 fog, 51-57 drizzle,
// 61-67 + 80-82 rain, 71-77 + 85-86 snow, 95-99 thunderstorm.
function getIconSpec(code: number, isNight: boolean, size: number): IconSpec {
  if (isNight && (code === 0 || code === 1)) {
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
  if (isNight && (code === 2 || code === 3)) {
    return { animation: 'cloud-drift', tone: 'tone-cloud', icon: <Cloud size={size} /> };
  }
  if (code === 0 || code === 1) {
    return { animation: 'sun-spin', tone: 'tone-sun', icon: <Sun size={size} /> };
  }
  if (code === 2) {
    return { animation: 'sun-cloud-drift', tone: 'tone-cloud', icon: <CloudSun size={size} /> };
  }
  if (code === 3 || code === 45 || code === 48) {
    return { animation: 'cloud-drift', tone: 'tone-cloud', icon: <Cloud size={size} /> };
  }
  if (code >= 51 && code <= 57) {
    return { animation: 'rain-fall', tone: 'tone-drizzle', icon: <CloudDrizzle size={size} /> };
  }
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) {
    return { animation: 'rain-fall', tone: 'tone-rain', icon: <CloudRain size={size} /> };
  }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) {
    return { animation: 'snow-spin', tone: 'tone-snow', icon: <CloudSnow size={size} /> };
  }
  if (code >= 95 && code <= 99) {
    return { animation: 'lightning-flash', tone: 'tone-storm', icon: <CloudLightning size={size} /> };
  }
  return { animation: 'sun-spin', tone: 'tone-sun', icon: <Sun size={size} /> };
}

export default function WeatherWidgetIcon({ code, isNight, size = 32 }: WeatherWidgetIconProps) {
  const spec = getIconSpec(code, isNight, size);

  return (
    <div className="weather-widget-wrap" aria-hidden="true">
      <div className={`weather-widget-icon ${spec.animation} ${spec.tone}`}>{spec.icon}</div>
    </div>
  );
}
