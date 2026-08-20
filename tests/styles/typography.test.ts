import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const stylesheetPaths = ['src/index.css', 'src/components.css'];
const stylesheets = stylesheetPaths.map((path) => ({
  path,
  source: readFileSync(resolve(process.cwd(), path), 'utf8'),
}));

describe('typography scale', () => {
  it('keeps visible CSS text at or above the 11px instrument floor', () => {
    const undersized = stylesheets.flatMap(({ path, source }) =>
      [...source.matchAll(/font-size:\s*([\d.]+)px/g)]
        .map((match) => ({ path, size: Number(match[1]), declaration: match[0] }))
        .filter(({ size }) => size > 0 && size < 11)
    );

    expect(undersized).toEqual([]);
  });

  it('defines the shared scale in root-relative units', () => {
    const root = stylesheets.find(({ path }) => path === 'src/index.css')?.source ?? '';

    expect(root).toContain('--text-instrument: 0.6875rem');
    expect(root).toContain('--text-caption: 0.75rem');
    expect(root).toContain('--text-ui: 0.8125rem');
    expect(root).toContain('--text-body: 0.875rem');
    expect(root).toContain('--text-title: 1rem');
  });

  it('keeps SVG chart ticks on the same instrument floor', () => {
    const charts = readFileSync(
      resolve(process.cwd(), 'src/components/WeatherCharts.tsx'),
      'utf8',
    );

    expect(charts).toContain('const TICK_FONT_SIZE = 11;');
  });

  it('keeps the collapsed section title keyboard target at least 24px high', () => {
    const components = stylesheets.find(({ path }) => path === 'src/components.css')?.source ?? '';
    const rule = components.match(/\.collapse-title-btn\s*\{([^}]*)\}/)?.[1] ?? '';
    const minHeight = Number(rule.match(/min-height:\s*([\d.]+)px/)?.[1]);
    expect(minHeight).toBeGreaterThanOrEqual(24);
  });
});
