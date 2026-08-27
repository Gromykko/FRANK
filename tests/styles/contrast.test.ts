import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

const ratingAndIconTokens = [
  '--color-safe',
  '--color-caution',
  '--color-danger',
  '--icon-sun',
  '--icon-moon',
  '--icon-rain',
  '--icon-snow',
] as const;

function extractBlock(pattern: RegExp, label: string): string {
  const block = stylesheet.match(pattern)?.[1];
  expect(block, `${label} token block`).toBeDefined();
  return block ?? '';
}

function parseTokens(block: string): Map<string, string> {
  return new Map(
    [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [
      match[1],
      match[2].trim(),
    ]),
  );
}

function resolveColor(token: string, tokens: Map<string, string>): string {
  const value = tokens.get(token);
  expect(value, `${token} is defined`).toBeDefined();

  const alias = value?.match(/^var\((--[\w-]+)\)$/)?.[1];
  return alias ? resolveColor(alias, tokens) : (value ?? '');
}

function relativeLuminance(hex: string): number {
  expect(hex).toMatch(/^#[\da-f]{6}$/i);
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255) ?? [];
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

describe('light-theme non-text contrast', () => {
  const baseTokens = parseTokens(extractBlock(/^:root\s*\{([^}]*)\}/m, 'base'));
  const lightThemeBlocks = [
    {
      label: 'system light theme',
      source: extractBlock(
        /@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root\s*\{([^}]*)\}/,
        'system light theme',
      ),
    },
    {
      label: 'explicit light theme',
      source: extractBlock(/:root\[data-theme="light"\]\s*\{([^}]*)\}/, 'explicit light theme'),
    },
  ];

  for (const { label, source } of lightThemeBlocks) {
    it(`${label} keeps rating and weather-icon colors at 3:1 against the app background`, () => {
      const tokens = new Map([...baseTokens, ...parseTokens(source)]);
      const background = resolveColor('--bg-app', tokens);

      for (const token of ratingAndIconTokens) {
        const color = resolveColor(token, tokens);
        expect(contrastRatio(color, background), `${token} (${color})`).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
