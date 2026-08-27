import { describe, expect, it } from 'vitest';
import { getWindChartThresholds } from '../../src/components/WeatherCharts';
import { getPresetSettings } from '../../src/features/safety/presets';

describe('WeatherCharts wind thresholds', () => {
  it('plots the Intermediate gust band at the same 1.6x boundaries as the verdict engine', () => {
    expect(getWindChartThresholds(getPresetSettings('default'))).toEqual({
      windTakeCare: 6,
      windDanger: 8,
      gustTakeCare: 9.6,
      gustDanger: 12.8,
    });
  });

  it('rounds gust boundaries to one decimal and applies the engine minimum danger gap', () => {
    const settings = {
      ...getPresetSettings('default'),
      windTakeCareAt: 4.2,
      // Even an invalid direct fixture cannot put Danger less than 0.5 m/s
      // above Take care. Stored settings apply a stricter validated minimum.
      windDangerGap: 0.1,
    };

    expect(getWindChartThresholds(settings)).toEqual({
      windTakeCare: 4.2,
      windDanger: 4.7,
      gustTakeCare: 6.7,
      gustDanger: 7.5,
    });
  });
});
