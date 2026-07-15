import type { SafetyRating } from '../features/safety/analyzeSafetyConditions';

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

const MOUTHS: Record<SafetyRating, string[]> = {
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
export default function GertyFace({ rating }: { rating: SafetyRating }) {
  return (
    <svg
      className="gerty-face"
      viewBox="3 3.5 10 9"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <g className="gerty-eyes">{gridRects(EYES)}</g>
      {gridRects(MOUTHS[rating])}
    </svg>
  );
}
