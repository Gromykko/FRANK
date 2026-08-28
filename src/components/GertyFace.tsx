import type { DisplayStatus } from '../features/safety/analyzeSafetyConditions';

// GERTY-style emoticon for the CRT status monitor (Moon, 2009), drawn as a
// 16x16 pixel grid so the face sits on the same pixel raster as the screen's
// scanlines. Every lit pixel renders in currentColor, so the face picks up
// the badge's phosphor rating color.
const EYES = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '....xx....xx....',
  '....xx....xx....',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
];

const MOUTHS: Record<DisplayStatus, string[]> = {
  // No verdict: at rest, not pleased. A narrow upturned mouth on a grey face
  // reads as a held smile rather than a friendly one - the expression a machine
  // wears when it wants something. A short level line says the device is on and
  // has no opinion, which is what Weather-only mode means. The wide flat line is
  // 'caution'; this one is half its width.
  none: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '......xxxx......',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  safe: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '....x......x....',
    '.....xxxxxx.....',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  caution: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '.....xxxxxx.....',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  danger: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '.....xxxxxx.....',
    '....x......x....',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
};

function gridRects(grid: string[]) {
  return grid.flatMap((row, y) =>
    Array.from(row, (ch, x) =>
      ch === 'x' ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} /> : null
    )
  );
}

// The device header renders the face inside a real circular CRT bezel, so the
// housing is the circle; the viewBox crops to the eyes and mouth (x 4–11,
// y 5–10 on the grid) so the face fills the screen.
export default function GertyFace({ rating }: { rating: DisplayStatus }) {
  return (
    <svg
      className="gerty-face"
      viewBox="3 3.5 10 9"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {/* One set of eyes for every state; only the mouth carries the verdict.
          They blink and otherwise hold still - the off-duty wander was a
          one-pixel teleport on a 16-pixel face, which read as a fault rather
          than a glance. */}
      <g className="gerty-eyes">{gridRects(EYES)}</g>
      <g className="gerty-mouth">{gridRects(MOUTHS[rating])}</g>
    </svg>
  );
}
