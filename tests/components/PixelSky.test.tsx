import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PixelSky from '../../src/components/PixelSky';

describe('PixelSky', () => {
  it('renders three non-interactive decorative clouds', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(<PixelSky />);

    const sky = container.querySelector('.pixel-sky');
    expect(sky?.getAttribute('aria-hidden')).toBe('true');
    expect(sky?.querySelectorAll('.pixel-cloud')).toHaveLength(3);
    expect(sky?.querySelectorAll('svg[focusable="false"]')).toHaveLength(3);
    expect(sky?.querySelectorAll('a, button, input')).toHaveLength(0);
  });
});
