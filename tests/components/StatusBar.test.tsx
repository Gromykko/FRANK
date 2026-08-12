import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HeaderUtilityMenu from '../../src/components/HeaderUtilityMenu';
import StatusBar from '../../src/components/StatusBar';

describe('redesigned FRANK header', () => {
  it('exposes only place, refresh and utilities as top-level actions', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <StatusBar
        rating="safe"
        phrase="Even the herring approve today"
        srTitle="Ready to paddle"
        srSubtitle="Have fun out there"
        location="Horsens"
        sourceLabel="Checked · 16:36"
        cacheDetail=""
        cacheClass="fresh"
        cacheAriaLabel="Checked · 16:36. Forecast from today."
        refreshing={false}
        onRefresh={vi.fn()}
        themeMode="light"
        onThemeChange={vi.fn()}
      />
    );

    const buttons = [...container.querySelectorAll('button')];
    expect(buttons).toHaveLength(3);
    expect(container.querySelector('.location-switcher-btn')?.textContent).toContain('Horsens');
    expect(container.querySelector('.frank-cache')?.getAttribute('aria-label'))
      .toContain('Refresh forecast. Checked · 16:36');
    expect(container.querySelector('.frank-utility-trigger')?.getAttribute('aria-label'))
      .toBe('Language and appearance');
    expect(container.querySelector('.frank-display')?.textContent)
      .toContain('Even the herring approve today');
    expect(container.querySelector('.flag-icon')).toBeNull();
  });

  it('keeps refresh focusable while reporting an in-flight update', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <StatusBar
        rating="safe"
        phrase="Even the herring approve today"
        srTitle="Ready to paddle"
        srSubtitle="Have fun out there"
        location="Horsens"
        sourceLabel="Refreshing…"
        cacheDetail=""
        cacheClass="neutral"
        cacheAriaLabel="Checking for a newer forecast"
        refreshing
        onRefresh={vi.fn()}
        themeMode="light"
        onThemeChange={vi.fn()}
      />
    );

    const refresh = container.querySelector<HTMLButtonElement>('.frank-cache');
    expect(refresh?.disabled).toBe(false);
    expect(refresh?.getAttribute('aria-disabled')).toBe('true');
    expect(refresh?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('[role="status"]')?.textContent)
      .toContain('Checking for a newer forecast');
  });
});

describe('header utility menu', () => {
  const roots: ReturnType<typeof createRoot>[] = [];

  afterEach(async () => {
    await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  });

  it('groups language and appearance behind one 48px utility entry', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const onThemeChange = vi.fn();

    await act(async () => {
      root.render(<HeaderUtilityMenu themeMode="light" onThemeChange={onThemeChange} />);
    });

    const trigger = container.querySelector<HTMLButtonElement>('.frank-utility-trigger')!;
    await act(async () => trigger.click());

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label'))
      .toBe('Language and appearance');
    expect(container.textContent).toContain('Language');
    expect(container.textContent).toContain('Appearance');

    const dark = [...container.querySelectorAll<HTMLButtonElement>('.frank-utility-option')]
      .find((button) => button.textContent?.includes('Dark'))!;
    await act(async () => dark.click());
    expect(onThemeChange).toHaveBeenCalledWith('dark');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    container.remove();
  });
});
