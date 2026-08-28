import { useCallback, useState } from 'react';
import { BookOpen, ChevronDown, ChevronUp, Clock, Navigation, Settings, Sun, Thermometer, Waves, Wind } from 'lucide-react';
import { getWindSpeedLabel, getWaveHeightLabel } from '../features/safety/analyzeSafetyConditions';
import { TRIP_PROFILE_LABELS } from '../features/safety/guidanceSources';
import SafetyManualModal from './SafetyManualModal';
import CustomSelect from './CustomSelect';
import CompassRose from './CompassRose';
import type { SafetySettings } from '../hooks/useSettings';
import { GUST_FACTOR, getNearLimitThreshold } from '../features/safety/presets';
import { CURRENT_LOCATION } from '../config/locations';
import type { WindSector } from '../config/locations';
import { clampNumber, roundToDecimals } from '../utils/number';
import { compassPoint, sectorMidBearing } from '../utils/compass';
import { useLang } from '../i18n';

interface SafetyLimitsPanelProps {
  settings: SafetySettings;
  updateSettings: (settings: SafetySettings) => void;
  // The last write to this device's storage failed, so what is on screen will
  // not survive a reload.
  saveFailed: boolean;
}

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  small?: boolean;
}

function ToggleSwitch({ checked, onChange, label, disabled, small = false }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle-switch ${checked ? 'is-on' : ''} ${small ? 'is-small' : ''}`}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    />
  );
}

interface StepperProps {
  value: number;
  min: number;
  max: number;
  step: number;
  decimals: number;
  unit: string;
  label: string;
  announcement?: string;
  onChange: (value: number) => void;
  disabled?: boolean;
  compact?: boolean;
}

function Stepper({ value, min, max, step, decimals, unit, label, announcement, onChange, disabled, compact = false }: StepperProps) {
  const { t } = useLang();
  const nudge = (dir: 1 | -1) => {
    // Snap onto the step grid so repeated 0.05 steps never drift into
    // 0.30000000000000004 territory
    const snapped = Math.round((value + dir * step) / step) * step;
    onChange(roundToDecimals(clampNumber(snapped, min, max, value), decimals));
  };
  return (
    <div className={`limit-value-row ${compact ? 'is-mini' : ''}`}>
      <button
        type="button"
        className="step-btn"
        onClick={() => nudge(-1)}
        disabled={disabled || value <= min}
        aria-label={t('Decrease {0}', label)}
      >
        &minus;
      </button>
      {/* Announced on change: the +/- buttons have static labels, so without
          this a screen-reader user nudging a safety threshold hears nothing
          back and cannot tell what they just set it to. */}
      <div className="limit-value" aria-live="polite" aria-atomic="true">
        <span className="limit-value-num">{value.toFixed(decimals)}</span>
        <small>{unit}</small>
        {announcement && <span className="sr-only">. {announcement}</span>}
      </div>
      <button
        type="button"
        className="step-btn"
        onClick={() => nudge(1)}
        disabled={disabled || value >= max}
        aria-label={t('Increase {0}', label)}
      >
        +
      </button>
    </div>
  );
}

interface ZoneBarProps {
  min: number;
  max: number;
  cautionStart: number;
  cautionEnd: number;
  invert?: boolean;
  leftLabel: string;
  midLabel?: string;
  rightLabel: string;
  showMaximumMarker?: boolean;
}

// A read-only gauge. The steppers above are the input, so this stays a thin
// strip with no draggable thumb. Inverted limits put the stronger state at the
// low end, as water temperature does.
function ZoneBar({
  min,
  max,
  cautionStart,
  cautionEnd,
  invert = false,
  leftLabel,
  midLabel,
  rightLabel,
  showMaximumMarker = false,
}: ZoneBarProps) {
  const pct = (v: number) => clampNumber(((v - min) / (max - min)) * 100, 0, 100, 0);
  return (
    <div className="limit-zone">
      <div
        className={`zone-bar ${invert ? 'is-inverted' : ''}${showMaximumMarker ? ' has-maximum' : ''}`}
        aria-hidden="true"
        style={{ '--zone-a': `${pct(cautionStart)}%`, '--zone-b': `${pct(cautionEnd)}%` } as React.CSSProperties}
      />
      <div className="zone-labels">
        <span>{leftLabel}</span>
        {midLabel && <span className="zone-label-mid">{midLabel}</span>}
        <span>{rightLabel}</span>
      </div>
    </div>
  );
}

interface MaximumBarProps {
  min: number;
  max: number;
  maximum: number;
  decimals: number;
  unit: string;
  leftLabel: string;
  rightLabel: string;
}

// Wind and waves keep one editable maximum. The caution point is derived, so
// the read-only gauge and sentence explain all three states without exposing a
// second control.
function MaximumBar({ min, max, maximum, decimals, unit, leftLabel, rightLabel }: MaximumBarProps) {
  const { t } = useLang();
  const cautionAt = getNearLimitThreshold(maximum, decimals);
  return (
    <div className="maximum-zone">
      <ZoneBar
        min={min}
        max={max}
        cautionStart={cautionAt}
        cautionEnd={maximum}
        leftLabel={leftLabel}
        rightLabel={rightLabel}
        showMaximumMarker
      />
      <p className="limit-boundary-summary">
        {t('Check from {0} {1} · Not recommended above {2} {1}', cautionAt.toFixed(decimals), unit, maximum.toFixed(decimals))}
      </p>
    </div>
  );
}

export default function SafetyLimitsPanel({ settings, updateSettings, saveFailed }: SafetyLimitsPanelProps) {
  const { t } = useLang();
  const [isOpen, setIsOpen] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  // Stable identity: the modal's focus effect keys off onClose, and a fresh
  // arrow each render made it re-run on every parent re-render (including the
  // 60s forecast heartbeat) — stealing focus back and breaking focus restore.
  const closeInfoModal = useCallback(() => setShowInfoModal(false), []);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const windSectors = CURRENT_LOCATION.windSectors;

  // Live-apply model: every tweak becomes the active settings immediately
  // (the matrix and launch windows react in real time) and is persisted as
  // the Custom profile, so there is nothing separate to "save".
  const updateCriteria = (updates: Partial<SafetySettings>) => {
    const next = { ...settings, ...updates, tripMode: 'custom' as const };
    updateSettings(next);
  };

  // A sector's live caps: the user's override if any, else the location default.
  const sectorCap = (sector: WindSector) =>
    settings.sectorLimits?.[sector.id] ?? {
      maximumAt: sector.maximumAt,
    };

  const setSectorCap = (sector: WindSector, maximumAt: number) => {
    updateCriteria({
      sectorLimits: {
        ...settings.sectorLimits,
        [sector.id]: { maximumAt },
      },
    });
  };

  const derivedGustLimit = roundToDecimals(settings.windLimit * GUST_FACTOR, 1);
  const derivedGustCautionAt = getNearLimitThreshold(derivedGustLimit, 1);
  const windCautionAt = getNearLimitThreshold(settings.windLimit, 1);
  const waveCautionAt = getNearLimitThreshold(settings.waveLimit, 2);
  const activeTripProfileLabel = settings.tripMode === 'weather'
    ? null
    : TRIP_PROFILE_LABELS[settings.tripMode];
  const tempHint = t(
    'Check below {0}°C · Not recommended at or below {1}°C',
    settings.waterTempTakeCareBelow,
    settings.waterTempDangerBelow,
  );

  // Silence here is the dangerous kind: the panel and the verdict both use the
  // new value straight away, so a failed write is invisible until the next
  // session quietly restores the OLD - and looser - limit. Full storage, or
  // Safari private mode throwing on first write, is enough to cause it.
  const saveWarning = saveFailed ? (
    <p className="settings-save-warning" role="alert">
      {t('This device would not save your limits, so they will go back to the previous values next time you open FRANK. They are active for now.')}
    </p>
  ) : null;

  const settingsPanel = (
    <div className="panel planner-settings-panel">
      {saveWarning}
      {/* APG accordion header: the toggle is a real button inside the
          heading (a focusable "?" nested in a role="button" div was an
          invalid control-in-control). The row's onClick is a pointer-only
          convenience - keyboard and AT go through the title button. */}
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- The nested title button provides the keyboard-equivalent toggle. */}
      <div
        className={`panel-collapse-header module-head ${isOpen ? 'is-open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="settings-copy">
          <h2 className="settings-title">
            <button
              type="button"
              className="collapse-title-btn"
              aria-expanded={isOpen}
              onClick={(e) => {
                e.stopPropagation();
                setIsOpen(!isOpen);
              }}
            >
              <Settings size={16} color="var(--primary)" /> {t('Your Limits')}
            </button>
            {/* A book, not a "?". The two info affordances in the app behave
                differently on purpose: this one opens the full manual, every
                formula filled in with the reader's own numbers, in a scrolling
                modal, while the trip-profile "?" expands three sentences inline.
                Both are right for what they hold, but rendered as identical "?"
                circles nothing told the reader which they would get. The glyph
                now says "document" rather than "note". */}
            <button
              type="button"
              className="settings-info-btn is-manual"
              onClick={(e) => {
                e.stopPropagation();
                setShowInfoModal(true);
              }}
              data-tip={t('How FRANK Decides')}
              aria-label={t('How FRANK Decides')}
            >
              <BookOpen size={15} aria-hidden="true" />
            </button>
          </h2>
          <span className="settings-subtitle">
            {activeTripProfileLabel
              ? t('Your personal limits · {0}', t(activeTripProfileLabel))
              : t('Your personal limits')}
          </span>
        </div>
        <div className="settings-collapse-chevron" aria-hidden="true">
          {isOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </div>
      </div>

      {isOpen && (
        <div className="settings-body">

          <p className="settings-autosave-note">
            {t('Any change applies immediately and switches you to Custom.')}
          </p>

          <p className="settings-headroom-note">
            {t("Each check point sits at 80% of the maximum you set. It is FRANK's own headroom rule — open the manual above for the detail.")}
          </p>

          <div className="limit-cards">

            {/* Wind */}
            <section className={`limit-card ${settings.enableWindSpeed ? '' : 'is-off'}`}>
              <div className="limit-head">
                <div className="limit-id">
                  <Wind size={20} className="setting-icon" />
                  <div className="limit-titles">
                    <span className="limit-name">{t('Maximum wind')}</span>
                    <span className="limit-hint">{t(getWindSpeedLabel(settings.windLimit))}</span>
                  </div>
                </div>
                <ToggleSwitch
                  checked={settings.enableWindSpeed}
                  onChange={checked => updateCriteria({ enableWindSpeed: checked })}
                  label={t('Wind limit enabled')}
                />
              </div>
              <Stepper
                value={settings.windLimit}
                // Keep one selectable step above zero. A 0.0 m/s maximum would
                // put every non-zero displayed wind outside the limit.
                min={0.5} max={25} step={0.5} decimals={1}
                unit={t('m/s wind')}
                label={t('Maximum wind')}
                announcement={t(
                  'Wind check from {0} m/s. If gust checking is on, gusts are checked from {1} m/s with a derived maximum of {2} m/s.',
                  windCautionAt.toFixed(1), derivedGustCautionAt.toFixed(1), derivedGustLimit.toFixed(1),
                )}
                onChange={windLimit => updateCriteria({ windLimit })}
                disabled={!settings.enableWindSpeed}
              />
              <MaximumBar
                min={0} max={25}
                maximum={settings.windLimit}
                decimals={1}
                unit={t('m/s')}
                leftLabel={t('0 calm')}
                rightLabel={t('25 storm')}
              />
              <div className={`limit-caution-row has-toggle ${settings.enableWindSpeed ? '' : 'is-off'}`}>
                <div className="limit-caution-copy">
                  <span className="limit-caution-name">{t('Use forecast gusts in the verdict')}</span>
                  <span className="limit-caution-hint">{t('Check from {0} m/s · derived maximum {1} m/s ({2}× the wind maximum).', derivedGustCautionAt.toFixed(1), derivedGustLimit.toFixed(1), GUST_FACTOR)}</span>
                </div>
                <ToggleSwitch
                  small
                  checked={settings.enableWindSpeed && settings.enableWindGust}
                  onChange={checked => updateCriteria({ enableWindGust: checked })}
                  label={t('Use forecast gusts in the verdict')}
                  disabled={!settings.enableWindSpeed}
                />
              </div>
            </section>

            {/* Waves */}
            <section className={`limit-card ${settings.enableWaveHeight ? '' : 'is-off'}`}>
              <div className="limit-head">
                <div className="limit-id">
                  <Waves size={20} className="setting-icon" />
                  <div className="limit-titles">
                    <span className="limit-name">{t('Maximum waves')}</span>
                    <span className="limit-hint">{t(getWaveHeightLabel(settings.waveLimit))}</span>
                  </div>
                </div>
                <ToggleSwitch
                  checked={settings.enableWaveHeight}
                  onChange={checked => updateCriteria({ enableWaveHeight: checked })}
                  label={t('Wave-height limit enabled')}
                />
              </div>
              {/* Metres, because that is the unit DMI publishes wave height in
                  and therefore the unit the meteogram's Waves row shows. */}
              <Stepper
                value={settings.waveLimit}
                min={0.1} max={3.0} step={0.05} decimals={2}
                unit={t('m waves')}
                label={t('Maximum waves')}
                announcement={t('Wave check from {0} m.', waveCautionAt.toFixed(2))}
                onChange={waveLimit => updateCriteria({ waveLimit })}
                disabled={!settings.enableWaveHeight}
              />
              <MaximumBar
                min={0} max={3}
                maximum={settings.waveLimit}
                decimals={2}
                unit={t('m')}
                leftLabel={t('0 flat')}
                rightLabel={t('3 rough')}
              />
            </section>

            {/* Water temperature */}
            <section className={`limit-card ${settings.enableWaterTemp ? '' : 'is-off'}`}>
              <div className="limit-head">
                <div className="limit-id">
                  <Thermometer size={20} className={`setting-icon ${settings.waterTempDangerBelow >= 15 ? 'is-safe' : settings.waterTempDangerBelow >= 10 ? 'is-caution' : 'is-danger'}`} />
                  <div className="limit-titles">
                    <span className="limit-name">{t('Water temperature')}</span>
                    <span className="limit-hint">{tempHint}</span>
                  </div>
                </div>
                <ToggleSwitch
                  checked={settings.enableWaterTemp}
                  onChange={checked => updateCriteria({ enableWaterTemp: checked })}
                  label={t('Water temperature limit enabled')}
                />
              </div>
              <Stepper
                value={settings.waterTempTakeCareBelow}
                min={6} max={25} step={1} decimals={0}
                unit={t('°C water')} label={t('water temperature check boundary')}
                announcement={tempHint}
                onChange={waterTempTakeCareBelow => updateCriteria({
                  waterTempTakeCareBelow,
                  // Keep one whole control step between the boundaries so the
                  // cold-water check range cannot disappear.
                  waterTempDangerBelow: Math.min(settings.waterTempDangerBelow, waterTempTakeCareBelow - 1),
                })}
                disabled={!settings.enableWaterTemp}
              />
              <ZoneBar
                min={0} max={25}
                invert
                cautionStart={settings.waterTempDangerBelow}
                cautionEnd={settings.waterTempTakeCareBelow}
                leftLabel={t('0 ice')}
                midLabel={t('Within limit from {0}°', settings.waterTempTakeCareBelow)}
                rightLabel={t('25 summer')}
              />
              <div className="limit-caution-row">
                <div className="limit-caution-copy">
                  <span className="limit-caution-name">{t('Not recommended at or below')}</span>
                  <span className="limit-caution-hint">{t('Set the colder boundary directly')}</span>
                </div>
                <Stepper
                  compact
                  value={settings.waterTempDangerBelow}
                  min={5} max={settings.waterTempTakeCareBelow - 1} step={1} decimals={0}
                  unit={t('°C water')} label={t('water temperature Not recommended boundary')}
                  announcement={tempHint}
                  onChange={waterTempDangerBelow => updateCriteria({ waterTempDangerBelow })}
                  disabled={!settings.enableWaterTemp}
                />
              </div>
            </section>

          </div>

          <button
            type="button"
            className="advanced-toggle"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen(!advancedOpen)}
          >
            <span>{t('Optional local wind sectors')}</span>
            {advancedOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>

          {advancedOpen && (
            <div className="advanced-body">
              <div className={`advanced-group ${settings.enableWindSpeed && settings.enableCustomWindDirs ? '' : 'is-off'}`}>
                <div className="advanced-row">
                  <div className="advanced-row-label">
                      <Navigation size={18} className="setting-icon" />
                    <div className="limit-titles">
                      <span className="limit-name">{t('Local wind sectors')}</span>
                      <span className="limit-hint">{t('Optional stricter limits for {0}, based on broad area estimates', CURRENT_LOCATION.areaName)}</span>
                    </div>
                  </div>
                  <ToggleSwitch
                    checked={settings.enableWindSpeed && settings.enableCustomWindDirs}
                    onChange={checked => updateCriteria({ enableCustomWindDirs: checked })}
                    label={t('Apply optional wind-sector limits')}
                    disabled={!settings.enableWindSpeed}
                  />
                </div>

                {windSectors.length > 0 && (
                  <div className="sector-panel" aria-disabled={!(settings.enableWindSpeed && settings.enableCustomWindDirs)}>
                    <p className="sector-lead">
                      {t('These optional limits are broad FRANK estimates, not current kayak-club rules. A matching sector can only make the general wind result stricter.')}
                    </p>

                    <div className="sector-rose-wrap">
                      <CompassRose sectors={windSectors} />

                      <div className="sector-list">
                        {windSectors.map((sector) => {
                          const cap = sectorCap(sector);
                          const cautionAt = getNearLimitThreshold(cap.maximumAt, 1);
                          const bearing = compassPoint(sectorMidBearing(sector.min, sector.max));
                          return (
                            <div key={sector.id} className={`sector-block exposure-${sector.exposure}`}>
                              <span className="sector-heading">
                                {t(sector.label)}
                                <span className="sector-bearing">{t('from {0}', t(bearing))}</span>
                              </span>
                              <p className="limit-hint">{t(sector.description)}</p>

                              <div className="limit-caution-row">
                                <div className="limit-caution-copy">
                                  <span className="limit-caution-name">{t('Maximum wind')}</span>
                                  <span className="limit-caution-hint">{t('Check from {0} m/s · maximum {1} m/s', cautionAt.toFixed(1), cap.maximumAt.toFixed(1))}</span>
                                </div>
                                <Stepper
                                  compact
                                  value={cap.maximumAt}
                                  min={0} max={25} step={0.5} decimals={1}
                                  unit="m/s" label={t('{0} maximum wind', t(sector.label))}
                                  onChange={maximumAt => setSectorCap(sector, maximumAt)}
                                  disabled={!(settings.enableWindSpeed && settings.enableCustomWindDirs)}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <p className="sector-note">
                      {t('The bearings are fixed. You can adjust only the wind speeds.')}
                    </p>
                  </div>
                )}
              </div>

            </div>
          )}

          <section className="planning-options" aria-labelledby="planning-options-title">
            <h3 className="planning-options-title" id="planning-options-title">{t('Planning rules')}</h3>

            <div className="advanced-row">
              <div className="advanced-row-label">
                <Clock size={18} className="setting-icon" />
                <div className="limit-titles">
                  <span className="limit-name">{t('Min Duration')}</span>
                  <span className="limit-hint">{t('Shortest usable launch window')}</span>
                </div>
              </div>
              <CustomSelect
                ariaLabel={t('Min Duration')}
                value={settings.minDuration}
                onChange={val => updateCriteria({ minDuration: val })}
                options={[
                  { value: 1, label: t('1 hour') },
                  { value: 2, label: t('{0} hours', 2) },
                  { value: 3, label: t('{0} hours', 3) },
                  { value: 4, label: t('{0} hours', 4) },
                  { value: 6, label: t('{0} hours', 6) }
                ]}
              />
            </div>

            <div className="advanced-row">
              <div className="advanced-row-label">
                <Sun size={18} className="setting-icon is-sun" />
                <div className="limit-titles">
                  <span className="limit-name">{t('Daylight Only')}</span>
                  <span className="limit-hint">{t('Night hours need a check before launch')}</span>
                </div>
              </div>
              <ToggleSwitch
                checked={settings.daylightOnly}
                onChange={checked => updateCriteria({ daylightOnly: checked })}
                label={t('Daylight Only')}
              />
            </div>
          </section>

        </div>
      )}
    </div>
  );

  return (
    <>
      {settingsPanel}
      {showInfoModal && (
        <SafetyManualModal
          settings={settings}
          onClose={closeInfoModal}
        />
      )}
    </>
  );
}
