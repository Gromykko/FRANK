import { describe, expect, it } from 'vitest';
import { assessKommuneCoverage, parseMeteoalarmFeed, warningsOverlapping } from '../../../src/features/forecast/parseWarnings';
import type { WeatherWarning } from '../../../src/features/forecast/types';

describe('assessKommuneCoverage (warning soft filter)', () => {
  const capWithList = '<description>Kategori 1 varsel. Gældende for: Hedensted, Horsens, Odder, Samsø og Trekant området.</description>';

  it('confirmed when an alias appears (case-insensitive)', () => {
    expect(assessKommuneCoverage(capWithList, ['Horsens'])).toBe('confirmed');
    expect(assessKommuneCoverage(capWithList, ['horsens'])).toBe('confirmed');
    // Umbrella alias: Vejle/Kolding match "Trekant området"
    expect(assessKommuneCoverage(capWithList, ['Vejle', 'Trekant'])).toBe('confirmed');
  });

  it('excluded only when a coverage list demonstrably exists without the alias', () => {
    expect(assessKommuneCoverage(capWithList, ['Aarhus'])).toBe('excluded');
  });

  it('fails open to unknown when no coverage-list marker is present', () => {
    expect(assessKommuneCoverage('<description>Kraftig regn ventes.</description>', ['Aarhus'])).toBe('unknown');
    expect(assessKommuneCoverage('', ['Aarhus'])).toBe('unknown');
    expect(assessKommuneCoverage(capWithList, [])).toBe('unknown');
  });
});

// Shape taken verbatim from the live MeteoAlarm Denmark Atom feed.
function entry(fields: {
  emmaId: string;
  event: string;
  severity: string;
  effective: string;
  onset?: string;
  expires: string;
  areaDesc?: string;
  title?: string;
}): string {
  return `
  <entry>
    <cap:geocode>
      <valueName>EMMA_ID</valueName>
      <value>${fields.emmaId}</value>
    </cap:geocode>
    <cap:areaDesc>${fields.areaDesc ?? 'Østjylland'}</cap:areaDesc>
    <cap:event>${fields.event}</cap:event>
    <cap:expires>${fields.expires}</cap:expires>
    <cap:effective>${fields.effective}</cap:effective>
    ${fields.onset ? `<cap:onset>${fields.onset}</cap:onset>` : ''}
    <cap:severity>${fields.severity}</cap:severity>
    <title>${fields.title ?? 'Warning'}</title>
  </entry>`;
}

function feed(entries: string[]): string {
  return `<?xml version="1.0"?><feed xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">${entries.join('')}</feed>`;
}

const NOW = Date.parse('2026-07-12T10:00:00Z');

describe('parseMeteoalarmFeed', () => {
  it('keeps only the region, drops expired, sorts most-severe first', () => {
    const xml = feed([
      entry({ emmaId: 'DK004', event: 'yellow Rain', severity: 'Moderate', effective: '2026-07-12T06:00:00+00:00', expires: '2026-07-13T16:00:00+00:00' }),
      entry({ emmaId: 'DK004', event: 'orange Wind', severity: 'Severe', effective: '2026-07-12T06:00:00+00:00', onset: '2026-07-12T12:00:00+00:00', expires: '2026-07-12T22:00:00+00:00' }),
      entry({ emmaId: 'DK001', event: 'red Thunderstorm', severity: 'Extreme', effective: '2026-07-12T06:00:00+00:00', expires: '2026-07-14T00:00:00+00:00' }),
      entry({ emmaId: 'DK004', event: 'yellow Rain', severity: 'Moderate', effective: '2026-07-10T00:00:00+00:00', expires: '2026-07-11T00:00:00+00:00' }),
    ]);

    const result = parseMeteoalarmFeed(xml, 'DK004', NOW);

    expect(result.map((w) => w.event)).toEqual(['Wind', 'Rain']); // orange before yellow
    expect(result[0].colour).toBe('orange');
    expect(result[1].colour).toBe('yellow');
    expect(result[0].areaDesc).toBe('Østjylland');
    expect(result[0].onset).toBe('2026-07-12T12:00:00+00:00');
  });

  it('collapses re-issued duplicates of the same hazard', () => {
    const xml = feed([
      entry({ emmaId: 'DK004', event: 'yellow Thunderstorm', severity: 'Moderate', effective: '2026-07-12T06:00:00+00:00', onset: '2026-07-12T22:00:00+00:00', expires: '2026-07-13T07:00:00+00:00' }),
      // Same hazard, only the effective (re-issue) stamp differs → one warning.
      entry({ emmaId: 'DK004', event: 'yellow Thunderstorm', severity: 'Moderate', effective: '2026-07-11T16:26:00+00:00', onset: '2026-07-12T22:00:00+00:00', expires: '2026-07-13T07:00:00+00:00' }),
      entry({ emmaId: 'DK004', event: 'yellow Rain', severity: 'Moderate', effective: '2026-07-12T06:00:00+00:00', onset: '2026-07-13T02:00:00+00:00', expires: '2026-07-13T16:00:00+00:00' }),
    ]);
    const result = parseMeteoalarmFeed(xml, 'DK004', NOW);
    expect(result).toHaveLength(2);
    expect(result.map((w) => w.event)).toEqual(['Thunderstorm', 'Rain']);
  });

  it('falls back to CAP severity for the colour when the event has no colour word', () => {
    const xml = feed([
      entry({ emmaId: 'DK004', event: 'Thunderstorm', severity: 'Extreme', effective: '2026-07-12T06:00:00+00:00', expires: '2026-07-12T20:00:00+00:00' }),
    ]);
    const [warning] = parseMeteoalarmFeed(xml, 'DK004', NOW);
    expect(warning.colour).toBe('red');
    expect(warning.event).toBe('Thunderstorm');
  });

  it('returns nothing without an emmaId or on junk input', () => {
    expect(parseMeteoalarmFeed(feed([]), 'DK004', NOW)).toEqual([]);
    expect(parseMeteoalarmFeed('not xml', 'DK004', NOW)).toEqual([]);
    expect(parseMeteoalarmFeed(feed([entry({ emmaId: 'DK004', event: 'yellow Rain', severity: 'Moderate', effective: '2026-07-12T06:00:00+00:00', expires: '2026-07-13T16:00:00+00:00' })]), '', NOW)).toEqual([]);
  });
});

describe('warningsOverlapping', () => {
  const xml = feed([
    entry({ emmaId: 'DK004', event: 'orange Wind', severity: 'Severe', effective: '2026-07-12T06:00:00+00:00', onset: '2026-07-12T12:00:00+00:00', expires: '2026-07-12T18:00:00+00:00' }),
  ]);
  const warnings = parseMeteoalarmFeed(xml, 'DK004', NOW);

  it('matches a window overlapping the hazard [onset, expires) span', () => {
    const start = Date.parse('2026-07-12T13:00:00+00:00');
    const end = Date.parse('2026-07-12T15:00:00+00:00');
    expect(warningsOverlapping(warnings, start, end)).toHaveLength(1);
  });

  it('does not match a window before onset', () => {
    const start = Date.parse('2026-07-12T08:00:00+00:00');
    const end = Date.parse('2026-07-12T11:00:00+00:00');
    expect(warningsOverlapping(warnings, start, end)).toHaveLength(0);
  });
});

describe('parseMeteoalarmFeed edge cases', () => {
  it('matches the target region even when it is not the first EMMA_ID in the entry', () => {
    const multi = `<feed xmlns:cap="x"><entry>
      <cap:geocode><valueName>EMMA_ID</valueName><value>DK001</value></cap:geocode>
      <cap:geocode><valueName>EMMA_ID</valueName><value>DK004</value></cap:geocode>
      <cap:areaDesc>Flere landsdele</cap:areaDesc>
      <cap:event>orange Wind</cap:event>
      <cap:expires>2026-07-12T20:00:00+00:00</cap:expires>
      <cap:effective>2026-07-12T06:00:00+00:00</cap:effective>
      <cap:severity>Severe</cap:severity>
      <title>Orange Wind</title>
    </entry></feed>`;
    const result = parseMeteoalarmFeed(multi, 'DK004', NOW);
    expect(result).toHaveLength(1);
    expect(result[0].event).toBe('Wind');
  });

  it('drops an entry with no expires', () => {
    const noExpires = `<feed><entry>
      <cap:geocode><valueName>EMMA_ID</valueName><value>DK004</value></cap:geocode>
      <cap:event>yellow Rain</cap:event>
      <cap:effective>2026-07-12T06:00:00+00:00</cap:effective>
      <cap:severity>Moderate</cap:severity>
    </entry></feed>`;
    expect(parseMeteoalarmFeed(noExpires, 'DK004', NOW)).toEqual([]);
  });

  it('falls back to yellow for an unknown severity with no colour word', () => {
    const xml = feed([entry({ emmaId: 'DK004', event: 'Wind', severity: 'Unknown', effective: '2026-07-12T06:00:00+00:00', expires: '2026-07-12T20:00:00+00:00' })]);
    expect(parseMeteoalarmFeed(xml, 'DK004', NOW)[0].colour).toBe('yellow');
  });

  it('labels a colour-only event as "Weather"', () => {
    const xml = feed([entry({ emmaId: 'DK004', event: 'yellow', severity: 'Moderate', effective: '2026-07-12T06:00:00+00:00', expires: '2026-07-12T20:00:00+00:00' })]);
    const w = parseMeteoalarmFeed(xml, 'DK004', NOW)[0];
    expect(w.event).toBe('Weather');
    expect(w.colour).toBe('yellow');
  });
});

describe('warningsOverlapping edge cases', () => {
  const t = (iso: string) => Date.parse(iso);
  const make = (over: Partial<WeatherWarning>): WeatherWarning => ({
    event: 'X', colour: 'yellow', effective: '2026-07-12T06:00:00+00:00',
    expires: '2026-07-12T12:00:00+00:00', url: 'u', ...over,
  });

  it('uses effective when onset is absent', () => {
    const list = [make({})]; // hazard from effective 06:00
    expect(warningsOverlapping(list, t('2026-07-12T07:00:00+00:00'), t('2026-07-12T08:00:00+00:00'))).toHaveLength(1);
  });

  it('is exclusive at the exact hazard boundaries', () => {
    const list = [make({ onset: '2026-07-12T09:00:00+00:00' })]; // hazard [09:00, 12:00)
    // window ending exactly at onset -> no overlap
    expect(warningsOverlapping(list, t('2026-07-12T07:00:00+00:00'), t('2026-07-12T09:00:00+00:00'))).toHaveLength(0);
    // window starting exactly at expires -> no overlap
    expect(warningsOverlapping(list, t('2026-07-12T12:00:00+00:00'), t('2026-07-12T13:00:00+00:00'))).toHaveLength(0);
  });
});
