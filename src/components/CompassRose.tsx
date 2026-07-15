import { useLang } from '../i18n';
import type { WindSector } from '../config/locations';

// A small marine-instrument compass that draws each wind sector as an arc on a
// bearing ring. Purely decorative, so it's aria-hidden — the named sector list
// beside it is what screen readers get. Handles any geometry and any number of
// sectors, including arcs that wrap through north.
const SIZE = 120;
const C = SIZE / 2;
const ARC_R = 40;
const RING_R = 40;
const LABEL_R = 53;

// Compass bearing (0 = N at top, 90 = E at right) → SVG coordinates.
function polar(bearingDeg: number, r: number) {
  const rad = (bearingDeg * Math.PI) / 180;
  return { x: C + r * Math.sin(rad), y: C - r * Math.cos(rad) };
}

function arcPath(min: number, max: number, r: number): string {
  let end = max;
  if (end <= min) end += 360; // sector wraps through north
  const largeArc = end - min > 180 ? 1 : 0;
  const a = polar(min, r);
  const b = polar(end, r);
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

export default function CompassRose({ sectors }: { sectors: WindSector[] }) {
  const { t } = useLang();
  return (
    <svg
      className="compass-rose"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx={C} cy={C} r={RING_R} className="compass-ring" />
      {[0, 90, 180, 270].map((b) => {
        const outer = polar(b, RING_R);
        const inner = polar(b, RING_R - 6);
        return <line key={b} x1={outer.x} y1={outer.y} x2={inner.x} y2={inner.y} className="compass-tick" />;
      })}
      {sectors.map((sector) => (
        <path key={sector.id} d={arcPath(sector.min, sector.max, ARC_R)} className={`compass-arc exposure-${sector.exposure}`} />
      ))}
      {['N', 'E', 'S', 'W'].map((label, index) => {
        const p = polar(index * 90, LABEL_R);
        return (
          <text key={label} x={p.x} y={p.y} className="compass-label" textAnchor="middle" dominantBaseline="central">
            {t(label)}
          </text>
        );
      })}
    </svg>
  );
}
