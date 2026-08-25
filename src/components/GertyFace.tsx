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
  // No verdict: a shorter, flatter mouth than 'caution', and the shell paints
  // it in muted grey rather than a safety colour. FRANK has no expression
  // because it has been asked not to have an opinion.
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
      {/* Off duty keeps its eyes OPEN and lets them wander (see .gerty-eyes in
          components.css). Shut lids read as a blink caught mid-frame, or worse
          as a fault; a face glancing away says "not watching this for you"
          while still obviously switched on. */}
      <g className="gerty-eyes">{gridRects(EYES)}</g>
      {gridRects(MOUTHS[rating])}
    </svg>
  );
}
