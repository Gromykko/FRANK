import { AlertTriangle, ChevronRight } from 'lucide-react';
import type { WeatherWarning } from '../features/forecast/types';
import { describeWarningArea, LEVEL_WORD } from '../features/forecast/parseWarnings';
import { useLang } from '../i18n';
import type { Translate } from '../i18n/interpolate';
import { formatDateShort, formatTime, isSameLocationDay } from '../utils/date';

interface WarningStripeProps {
  warnings?: WeatherWarning[];
}


// "until 16:00" within today, "until Sun 16:00" once it crosses a day.
function untilLabel(t: Translate, expires: string): string {
  return isSameLocationDay(expires, Date.now())
    ? t('until {0}', formatTime(expires))
    : t('until {0} {1}', formatDateShort(expires), formatTime(expires));
}

// The Google-style official-warning stripe: the highest-severity active DMI
// varsel for the location's region, linking out to DMI for full details. Purely
// advisory — it never changes the safety verdict. Renders nothing when clear.
export default function WarningStripe({ warnings }: WarningStripeProps) {
  const { lang, t } = useLang();
  const now = Date.now();
  // The worker filters by region and drops lapsed warnings, but a cached payload
  // can outlive one — re-check expiry here so the stripe self-heals without a
  // rebuild. Parser sorts most-severe first, so [0] is the one to headline.
  const active = (warnings ?? []).filter((w) => Date.parse(w.expires) > now);
  if (active.length === 0) return null;

  const top = active[0];
  const count = active.length;
  const level = t(LEVEL_WORD[top.colour]);
  // The feed is region-level (e.g. all of Østjylland), so name the region + the
  // level + how many — NOT the specific hazard. A "Thunderstorm" warning for the
  // whole region may not touch this town; DMI's linked map has the what/where.
  // The colour/level is genuinely true for the region, so we keep it. (The
  // kommune-coverage check is NOT applied here by choice — the stripe always
  // shows the region truth; coverage only filters launch-window badges.)
  // Danish shows DMI's own Danish areaDesc verbatim ("Gul varsel · Østjylland");
  // English goes through the shared region mapping.
  const region = lang === 'da' ? (top.areaDesc ?? t('your region')) : describeWarningArea(top.areaDesc);
  const allSameLevel = active.every((w) => w.colour === top.colour);
  const headline =
    count === 1
      ? t('{0} warning · {1}', level, region)
      : allSameLevel
        ? t('{0} {1} · {2}', count, t(`${LEVEL_WORD[top.colour]} warnings`), region)
        : t('{0} warning · {1} · +{2} more', level, region, count - 1);

  const ariaCount =
    count === 1
      ? t('{0} weather warning', level)
      : allSameLevel
        ? t('{0} {1}', count, t(`${LEVEL_WORD[top.colour]} weather warnings`))
        : t('{0} weather warning and {1} more', level, count - 1);
  const ariaLabel =
    t('{0} for the {1}, {2}.', ariaCount, region, untilLabel(t, top.expires)) +
    ' ' + t('Opens DMI warnings in a new tab for the full details.');

  return (
    <a
      className={`warning-stripe warning-stripe--${top.colour}`}
      href={top.url}
      target="_blank"
      rel="noreferrer"
      aria-label={ariaLabel}
    >
      <AlertTriangle size={18} className="warning-stripe-icon" aria-hidden="true" />
      <span className="warning-stripe-body">
        <span className="warning-stripe-title">{headline}</span>
        <span className="warning-stripe-meta">{untilLabel(t, top.expires)}</span>
      </span>
      <span className="warning-stripe-source" aria-hidden="true">DMI</span>
      <ChevronRight size={18} className="warning-stripe-chevron" aria-hidden="true" />
    </a>
  );
}
