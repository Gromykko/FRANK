import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { da } from '../src/i18n/da';
import {
  getCompactWeatherDescription,
  getWeatherDescription,
} from '../src/features/forecast/weatherCodes';

// A missing Danish entry soft-fails to English by design, which is the right
// runtime behaviour and a terrible development one: the app keeps working, in
// the wrong language, silently. Every rename of a translated string is a chance
// to leave one behind — this file exists because a batch of unit labels was
// renamed from "(m)" to "(cm)" and nothing would have noticed if the Danish
// side had been missed.
//
// Only single-quoted literal keys can be checked statically. Keys built from
// variables or template strings are skipped, which is why interpolation uses
// {0} placeholders inside an otherwise literal key.

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

// t('...') and translate('...'), single-quoted or double-quoted, allowing escaped quotes.
const CALL = /\b(?:t|translate)\(\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1/g;

const files = sourceFiles(resolve(process.cwd(), 'src'));

describe('Danish dictionary covers every translated literal', () => {
  it('finds source files to scan at all', () => {
    // Guards against the scan silently passing because it walked nothing.
    expect(files.length).toBeGreaterThan(15);
  });

  it('has a da.ts entry for every t() / translate() literal in src', () => {
    const missing: string[] = [];

    for (const file of files) {
      // The dictionary quotes every English string as a key; scanning it would
      // report its own keys as call sites.
      if (file.endsWith(`i18n${sep}da.ts`)) continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(CALL)) {
        const quote = match[1];
        const raw = match[2];
        const key = quote === "'" ? raw.replace(/\\'/g, "'") : raw.replace(/\\"/g, '"');
        if (key in da) continue;
        // A key with no letters carries no language: t('{0} {1} · {2}') is pure
        // assembly, and a Danish "translation" of it would be the same string.
        if (!/\p{L}/u.test(key)) continue;
        missing.push(`${file.split(/[/\\]src[/\\]/)[1]}: ${key}`);
      }
    }

    expect(missing, `these strings would render in English for Danish users:\n${missing.join('\n')}`).toEqual([]);
  });

  it('has no unit label still claiming metres for water level', () => {
    // The water-level unit is centimetres app-wide (DMI publishes vandstand in
    // cm). A stray "(m)" here would put two units for one quantity on screen.
    const stale = Object.keys(da).filter((k) => /water level.*\(m\)/i.test(k));
    expect(stale).toEqual([]);
  });

  it('uses the compact Niveau term consistently for water-level labels', () => {
    expect(da.Level).toBe('Niveau');
    expect(da['Water level']).toBe('Niveau');
    expect(da['Water level (cm)']).toBe('Niveau (cm)');
    expect(da['Water level: high water']).toBe('Niveau: højvande');
    expect(da['Water level: high water, low water, both, or near mean.'])
      .toBe('Niveau: højvande, lavvande, begge eller omkring middel.');
  });

  it('covers every full and compact weather-code description', () => {
    // Weather labels are returned from lookup tables and then passed to t(), so
    // the literal-call scanner above cannot see them. Walking the complete WMO
    // code range catches both mapped descriptions and the unknown fallbacks.
    const descriptions = new Set<string>();
    for (let code = 0; code <= 99; code += 1) {
      descriptions.add(getWeatherDescription(code));
      descriptions.add(getCompactWeatherDescription(code));
    }

    const missing = [...descriptions].filter(description => !(description in da));
    expect(missing, `weather descriptions missing Danish translations: ${missing.join(', ')}`)
      .toEqual([]);
  });
});
