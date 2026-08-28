import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getWindChartThresholds } from '../../src/components/WeatherCharts';
import { getPresetSettings } from '../../src/features/safety/presets';

describe('WeatherCharts wind thresholds', () => {
  it('plots the Intermediate wind maximum and its derived 1.6x gust maximum', () => {
    expect(getWindChartThresholds(getPresetSettings('default'))).toEqual({
      windCautionAt: 6.4,
      windLimit: 8,
      gustCautionAt: 10.2,
      gustLimit: 12.8,
    });
  });

  it('rounds the derived gust maximum to one decimal', () => {
    const settings = {
      ...getPresetSettings('default'),
      windLimit: 4.2,
    };

    expect(getWindChartThresholds(settings)).toEqual({
      windCautionAt: 3.4,
      windLimit: 4.2,
      // The maximum rounds first (4.2 x 1.6 = 6.72 -> 6.7), then its 80%
      // caution boundary rounds at the same displayed precision.
      gustCautionAt: 5.4,
      gustLimit: 6.7,
    });
  });

  it('draws caution bands through each inclusive maximum and danger washes only above it', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/WeatherCharts.tsx'), 'utf8');

    expect(source).toContain("const CAUTION_LINE = 'var(--color-caution)';");
    expect(source).toContain("const DANGER_LINE = 'var(--color-danger)';");
    expect(source).toContain("const MAXIMUM_LINE = 'var(--text-muted)';");

    expect(source).toContain('<ReferenceArea y1={windCautionAt} y2={windLimit} fill={CAUTION_LINE}');
    expect(source).toContain('<ReferenceArea y1={windLimit} y2={windAxisMax} fill={DANGER_LINE}');
    expect(source).toContain('<ReferenceLine y={windCautionAt} stroke={CAUTION_LINE}');
    expect(source).toContain('<ReferenceLine y={windLimit} stroke={MAXIMUM_LINE}');
    expect(source).toContain('<ReferenceLine y={gustCautionAt} stroke={CAUTION_LINE}');
    expect(source).toContain('<ReferenceLine y={gustLimit} stroke={MAXIMUM_LINE}');

    expect(source).toContain('<ReferenceArea y1={waveCautionAt} y2={waveLimit} fill={CAUTION_LINE}');
    expect(source).toContain('<ReferenceArea y1={waveLimit} y2={waveAxisMax} fill={DANGER_LINE}');
    expect(source).toContain('<ReferenceLine y={waveCautionAt} stroke={CAUTION_LINE}');
    expect(source).toContain('<ReferenceLine y={waveLimit} stroke={MAXIMUM_LINE}');

    expect(source.match(/tone: 'caution' as const/g)).toHaveLength(4);
    expect(source.match(/tone: 'muted' as const/g)).toHaveLength(3);
    expect(source).toContain("...(windLimitsOn ? [{ value: windCautionAt, label: t('wind check {0}'");
    expect(source).toContain("...(gustLimitsOn ? [{ value: gustCautionAt, label: t('gust check {0}'");
    expect(source).toContain("...(waveLimitsOn ? [{ value: waveCautionAt, label: t('wave check {0}'");
    expect(source).toContain("...(tempLimitsOn");
  });
});
