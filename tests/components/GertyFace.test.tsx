import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import GertyFace from '../../src/components/GertyFace';

function renderFace(rating: 'none' | 'safe') {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<GertyFace rating={rating} />);
  return host;
}

function pixels(host: HTMLElement, selector: string): string[] {
  return [...host.querySelectorAll<SVGRectElement>(`${selector} rect`)]
    .map((rect) => `${rect.getAttribute('x')},${rect.getAttribute('y')}`);
}

describe('GertyFace Weather-only expression', () => {
  it('rests on a short level mouth, and never changes the eyes', () => {
    const weather = renderFace('none');
    const safe = renderFace('safe');

    expect(pixels(weather, '.gerty-eyes')).toEqual(pixels(safe, '.gerty-eyes'));
    // No raised corners: a narrow smile on a grey face reads as held rather
    // than friendly. Level, and half the width of caution's full-width line.
    expect(pixels(weather, '.gerty-mouth')).toEqual([
      '6,10', '7,10', '8,10', '9,10',
    ]);
    expect(pixels(weather, '.gerty-mouth')).not.toEqual(pixels(safe, '.gerty-mouth'));
  });
});
