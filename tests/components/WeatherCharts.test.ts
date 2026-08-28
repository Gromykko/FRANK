import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getWindChartThresholds } from '../../src/components/WeatherCharts';
import { getPresetSettings } from '../../src/features/safety/presets';

describe('WeatherCharts wind thresholds', () => {
  it('plots the Intermediate wind maximum and its derived 1.6x gust maximum', () => {
    expect(getWindChartThresholds(getPresetSettings('default'))).toEqual({
      windLimit: 8,
      gustLimit: 12.8,
    });
  });

  it('rounds the derived gust maximum to one decimal', () => {
    const settings = {
      ...getPresetSettings('default'),
      windLimit: 4.2,
    };

    expect(getWindChartThresholds(settings)).toEqual({
      windLimit: 4.2,
      gustLimit: 6.7,
    });
  });

  it('draws inclusive upper maxima as neutral boundaries, without a danger wash starting at the wave maximum', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/WeatherCharts.tsx'), 'utf8');

    expect(source).toContain("const MAXIMUM_LINE = 'var(--text-muted)';");
    expect(source).toContain('<ReferenceLine y={windLimit} stroke={MAXIMUM_LINE}');
    expect(source).toContain('<ReferenceLine y={gustLimit} stroke={MAXIMUM_LINE}');
    expect(source).toContain('<ReferenceLine y={waveLimit} stroke={MAXIMUM_LINE}');
    expect(source).not.toContain('<ReferenceArea y1={waveLimit}');
    expect(source.match(/tone: 'muted' as const/g)).toHaveLength(3);
  });
});
