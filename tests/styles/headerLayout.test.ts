import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/components.css'), 'utf8');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? '';
}

describe('FRANK header touch geometry', () => {
  it('gives every persistent phone control a 48px target', () => {
    expect(rule('.location-switcher-btn')).toContain('min-height: 48px');
    expect(rule('.frank-cache')).toContain('min-height: 48px');
    expect(rule('.frank-utility-trigger')).toContain('width: 48px');
    expect(rule('.frank-utility-trigger')).toContain('height: 48px');
  });

  it('keeps utility choices at the same touch floor', () => {
    expect(rule('.frank-utility-option')).toContain('min-height: 48px');
    expect(rule('.location-switcher-option')).toContain('min-height: 48px');
  });

  it('keeps the voice visible at every supported phone width', () => {
    const compactPhone = css.match(/@media \(max-width: 360px\)[\s\S]+$/)?.[0] ?? '';
    expect(compactPhone).not.toMatch(/\.frank-cell-display\s*\{[^}]*display:\s*none/);
    expect(compactPhone).toContain("'voice    voice   voice'");
  });
});
