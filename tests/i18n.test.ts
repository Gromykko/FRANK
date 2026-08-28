import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { da } from '../src/i18n/da';
import { MET_WEATHER_SYMBOLS } from '../src/features/forecast/weatherSymbols';
import { WEATHER_POLICY_GROUPS } from '../src/features/forecast/weatherPolicyPresentation';
import { RATING_WORD } from '../src/features/safety/analyzeSafetyConditions';
import { getFrankPhrase } from '../src/features/safety/frankPhrases';

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
    expect(da['Water level: above mean']).toBe('Niveau: over middel');
    expect(da['Water level: above mean, below mean, spans both sides, or at mean.'])
      .toBe('Niveau: over middel, under middel, på begge sider eller ved middel.');
  });

  it('covers every native MET weather-symbol description', () => {
    // Weather labels come from the provider catalog and are then passed to t(),
    // so the literal-call scanner above cannot see them.
    const descriptions = Object.values(MET_WEATHER_SYMBOLS).map(({ description }) => description);
    const missing = descriptions.filter(description => !(description in da));
    expect(missing, `weather descriptions missing Danish translations: ${missing.join(', ')}`)
      .toEqual([]);
    expect(da['Unknown weather']).toBe('Ukendt vejr');
    expect(da.weather).toBe('vejr');
  });

  it('covers every dynamically rendered weather-policy group', () => {
    const keys = WEATHER_POLICY_GROUPS.flatMap(({ conditionLabel, policyNote }) => [
      conditionLabel,
      policyNote,
    ]);
    const missing = keys.filter((key) => !(key in da));

    expect(missing, `weather-policy manual copy missing Danish translations: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('covers verdict copy selected dynamically at runtime', () => {
    // RATING_WORD, the header subtitles and getFrankPhrase() all reach t()
    // through variables or a conditional expression, so the literal scanner
    // above cannot see their English keys.
    const keys = new Set([
      ...Object.values(RATING_WORD),
      'Limits are off: raw forecast only',
      'Read the checks below',
      'Choose another time',
    ]);
    const safePhrases = new Set<string>();

    // The real phrase seed is a YYYY-MM-DD date. A little over one year covers
    // every deterministic slot in all three phrase pools without duplicating
    // the phrase catalogue in this test.
    for (let day = 0; day < 400; day += 1) {
      const seed = new Date(Date.UTC(2026, 0, day + 1)).toISOString().slice(0, 10);
      for (const rating of ['safe', 'caution', 'danger'] as const) {
        const phrase = getFrankPhrase(rating, seed);
        keys.add(phrase);
        if (rating === 'safe') safePhrases.add(phrase);
      }
    }

    // The same display is used for an hour and for a 6/12-hour outlook block.
    // Safe phrases must not claim an hourly scope or that an unavailable gust
    // check was completed.
    expect([...safePhrases].every((phrase) => !/\bhour\b|all selected checks/i.test(phrase))).toBe(true);

    const missing = [...keys].filter(key => !(key in da));
    expect(missing, `dynamic verdict copy missing Danish translations: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('uses plain Danish for the automatic near-limit band', () => {
    expect(da['Check from {0} {1} · Not recommended above {2} {1}'])
      .toBe('Tjek fra {0} {1} · frarådes over {2} {1}');
    expect(da['Wave height is from {0} through {1} m.'])
      .toBe('Bølgehøjden ligger fra {0} til og med {1} m.');
    expect(da['Check before launch periods:']).toBe('Perioder, der skal tjekkes:');
    expect(da['these stay amber in the full forecast so you can inspect the reason, but they are not promoted into the green launch-window list.'])
      .toContain('de bliver ikke gjort til grønne rovinduer');
  });
});
