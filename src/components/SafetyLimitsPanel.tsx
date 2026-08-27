import { useCallback, useState } from 'react';
import { BookOpen, ChevronDown, ChevronUp, Clock, Navigation, Settings, Sun, Thermometer, Waves, Wind } from 'lucide-react';
import { getWindSpeedLabel, getWaveHeightLabel } from '../features/safety/analyzeSafetyConditions';
import SafetyManualModal from './SafetyManualModal';
import CustomSelect from './CustomSelect';
import CompassRose from './CompassRose';
import type { SafetySettings } from '../hooks/useSettings';
import {
  GUST_FACTOR,
  floorDanger,
  getWaveDangerAt,
  getWindDangerAt,
  MIN_DANGER_GAP,
} from '../features/safety/presets';
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
  onChange: (value: number) => void;
  disabled?: boolean;
  compact?: boolean;
}

function Stepper({ value, min, max, step, decimals, unit, label, onChange, disabled, compact = false }: StepperProps) {
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
  // When the caution band is switched off the rule goes straight from safe to
  // danger, so the bar must not keep drawing an amber zone the verdict no
  // longer has. The picture has to agree with the logic.
  showCaution?: boolean;
  invert?: boolean;
  leftLabel: string;
  midLabel?: string;
  rightLabel: string;
}

// A read-only gauge showing where the configured limit sits between calm and
// dangerous: the green-to-amber boundary IS the limit, the amber band IS the
// caution margin. Deliberately styled as a thin strip with no thumb - it
// used to look like a slider, and users tried to drag it. The steppers above
// are the input; this only reads. Inverted for limits where danger is at the
// low end (water temperature).
function ZoneBar({ min, max, cautionStart, cautionEnd, showCaution = true, invert = false, leftLabel, midLabel, rightLabel }: ZoneBarProps) {
  const pct = (v: number) => clampNumber(((v - min) / (max - min)) * 100, 0, 100, 0);
  // Collapsing the band onto the danger point rather than hiding the bar: the
  // danger boundary still exists and still moves with the margin, so it must
  // stay visible. Only the amber stretch disappears.
  const bandStart = showCaution ? cautionStart : cautionEnd;
  return (
    <div className="limit-zone">
      <div
        className={`zone-bar ${invert ? 'is-inverted' : ''}`}
        aria-hidden="true"
        style={{ '--zone-a': `${pct(bandStart)}%`, '--zone-b': `${pct(cautionEnd)}%` } as React.CSSProperties}
      />
      <div className="zone-labels">
        <span>{leftLabel}</span>
        {midLabel && <span className="zone-label-mid">{midLabel}</span>}
        <span>{rightLabel}</span>
      </div>
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
      takeCareAt: sector.takeCareAt,
      dangerAt: sector.dangerAt,
    };

  const setSectorCap = (sector: WindSector, takeCareAt: number, dangerAt: number) => {
    updateCriteria({
      sectorLimits: {
        ...settings.sectorLimits,
        [sector.id]: { takeCareAt, dangerAt: floorDanger(takeCareAt, dangerAt) },
      },
    });
  };

  const windDangerAt = getWindDangerAt(settings);
  const waveDangerAt = getWaveDangerAt(settings);
  const tempTakeCareBand = Math.max(
    1,
    Math.round(settings.waterTempTakeCareBelow - settings.waterTempDangerBelow),
  );

  const tempHint = t(
    'Take care below {0}°C · Rough below {1}°C',
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
          <span className="settings-subtitle">{t('Your personal limits')}</span>
        </div>
        <div className="settings-collapse-chevron" aria-hidden="true">
          {isOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </div>
      </div>

      {isOpen && (
        <div className="settings-body">

          <p className="settings-autosave-note">
            {t('Changes apply immediately and switch you to Custom mode. Pick a preset in the Trip Profile at the top (Beginner, Intermediate, Advanced) to go back.')}
          </p>

          <div className="limit-cards">

            {/* Wind */}
            <section className={`limit-card ${settings.enableWindSpeed ? '' : 'is-off'}`}>
              <div className="limit-head">
                <div className="limit-id">
                  <Wind size={20} className={`setting-icon ${settings.windTakeCareAt >= 10 ? 'is-danger' : settings.windTakeCareAt > 6 ? 'is-caution' : ''}`} />
                  <div className="limit-titles">
                    <span className="limit-name">{t('Wind — Take care from')}</span>
                    <span className="limit-hint">{t(getWindSpeedLabel(settings.windTakeCareAt))}</span>
                  </div>
                </div>
                <ToggleSwitch
                  checked={settings.enableWindSpeed}
                  onChange={checked => updateCriteria({ enableWindSpeed: checked })}
                  label={t('Wind limit enabled')}
                />
              </div>
              <Stepper
                value={settings.windTakeCareAt}
                // Floored at one step: 0.0 made a glassy 0.0 m/s morning rate
                // Take care against "your threshold of 0.0 m/s". 0.5 still
                // expresses the most conservative paddler there is.
                min={0.5} max={25} step={0.5} decimals={1}
                unit={t('m/s wind')}
                label={t('wind Take care threshold; Danger stays {0} m/s above', settings.windDangerGap.toFixed(1))}
                onChange={windTakeCareAt => updateCriteria({ windTakeCareAt })}
                disabled={!settings.enableWindSpeed}
              />
              <ZoneBar
                min={0} max={25}
                cautionStart={settings.windTakeCareAt}
                cautionEnd={windDangerAt}
                leftLabel={t('0 calm')}
                midLabel={t('danger from {0}', windDangerAt.toFixed(1))}
                rightLabel={t('25 storm')}
              />
              {/* The margin sets where average wind becomes dangerous. Gust checking is
                  a separate rule, so its switch gets a separate, visibly labelled row. */}
              <div className={`limit-caution-row ${settings.enableWindSpeed ? '' : 'is-off'}`}>
                <div className="limit-caution-copy">
                  <span className="limit-caution-name">{t('Gap to Danger')}</span>
                  <span className="limit-caution-hint">{t('Take care from {0} m/s; +{1} m/s sets Danger from {2} m/s.', settings.windTakeCareAt.toFixed(1), settings.windDangerGap.toFixed(1), windDangerAt.toFixed(1))}</span>
                </div>
                <Stepper
                  compact
                  value={settings.windDangerGap}
                  min={1} max={10} step={0.5} decimals={1}
                  unit="+m/s" label={t('wind Take care-to-Danger gap')}
                  onChange={windDangerGap => updateCriteria({ windDangerGap })}
                  disabled={!settings.enableWindSpeed}
                />
              </div>
              <div className={`limit-caution-row has-toggle ${settings.enableWindSpeed ? '' : 'is-off'}`}>
                <div className="limit-caution-copy">
                  <span className="limit-caution-name">{t('Gusts in verdict')}</span>
                  <span className="limit-caution-hint">{t("Checks forecast gusts against FRANK's separate 1.6x band: Take care from {0} m/s and Danger from {1} m/s.", (settings.windTakeCareAt * GUST_FACTOR).toFixed(1), (windDangerAt * GUST_FACTOR).toFixed(1))}</span>
                </div>
                <ToggleSwitch
                  small
                  checked={settings.enableWindSpeed && settings.enableWindGust}
                  onChange={checked => updateCriteria({ enableWindGust: checked })}
                  label={t('Include gusts in verdict')}
                  disabled={!settings.enableWindSpeed}
                />
              </div>
            </section>

            {/* Waves */}
            <section className={`limit-card ${settings.enableWaveHeight ? '' : 'is-off'}`}>
              <div className="limit-head">
                <div className="limit-id">
                  <Waves size={20} className={`setting-icon ${settings.waveTakeCareAt >= 1.0 ? 'is-danger' : settings.waveTakeCareAt >= 0.5 ? 'is-caution' : ''}`} />
                  <div className="limit-titles">
                    <span className="limit-name">{t('Waves — Take care from')}</span>
                    <span className="limit-hint">{t(getWaveHeightLabel(settings.waveTakeCareAt))}</span>
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
                value={settings.waveTakeCareAt}
                min={0.1} max={3.0} step={0.05} decimals={2}
                unit={t('m waves')}
                label={t('wave Take care threshold; Danger stays {0} m above', settings.waveDangerGap.toFixed(2))}
                onChange={waveTakeCareAt => updateCriteria({ waveTakeCareAt })}
                disabled={!settings.enableWaveHeight}
              />
              <ZoneBar
                min={0} max={3}
                cautionStart={settings.waveTakeCareAt}
                cautionEnd={waveDangerAt}
                showCaution={settings.enableWaveHeight && (settings.enableWaveTakeCare ?? true)}
                leftLabel={t('0 flat')}
                midLabel={t('danger from {0}', waveDangerAt.toFixed(2))}
                rightLabel={t('3 rough')}
              />
              {/* Same split as wind: the stepper sets the danger ceiling, which always
                  applies while wave height is on; the switch only adds the amber band
                  beneath it. With the switch off the rule goes green straight to red. */}
              <div className={`limit-caution-row has-toggle ${settings.enableWaveHeight ? '' : 'is-off'}`}>
                <div className="limit-caution-copy">
                  <span className="limit-caution-name">{t('Gap to Danger')}</span>
                  <span className="limit-caution-hint">{t('Take care from {0} m; +{1} m sets Danger from {2} m. The switch adds the amber band between them.', settings.waveTakeCareAt.toFixed(2), settings.waveDangerGap.toFixed(2), waveDangerAt.toFixed(2))}</span>
                </div>
                <Stepper
                  compact
                  value={settings.waveDangerGap}
                  min={0.05} max={2.0} step={0.05} decimals={2}
                  unit="+m" label={t('wave Take care-to-Danger gap')}
                  onChange={waveDangerGap => updateCriteria({ waveDangerGap })}
                  disabled={!settings.enableWaveHeight}
                />
                <ToggleSwitch
                  small
                  checked={settings.enableWaveHeight && settings.enableWaveTakeCare}
                  onChange={checked => updateCriteria({ enableWaveTakeCare: checked })}
                  label={t('Use Take care wave band in verdict')}
                  disabled={!settings.enableWaveHeight}
                />
              </div>
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
                value={settings.waterTempDangerBelow}
                min={5} max={20} step={1} decimals={0}
                unit={t('°C water')} label={t('water temperature Rough threshold')}
                onChange={val => updateCriteria({ waterTempDangerBelow: val, waterTempTakeCareBelow: val + tempTakeCareBand })}
                disabled={!settings.enableWaterTemp}
              />
              <ZoneBar
                min={0} max={25}
                invert
                cautionStart={settings.waterTempDangerBelow}
                cautionEnd={settings.waterTempTakeCareBelow}
                leftLabel={t('0 ice')}
                midLabel={t('Good to go from {0}°', settings.waterTempTakeCareBelow)}
                rightLabel={t('25 summer')}
              />
              <div className="limit-caution-row">
                <div className="limit-caution-copy">
                  <span className="limit-caution-name">{t('Cold-water margin')}</span>
                  <span className="limit-caution-hint">{t('{0}–{1} °C asks for thermal wear', settings.waterTempDangerBelow, settings.waterTempTakeCareBelow)}</span>
                </div>
                <Stepper
                  compact
                  value={tempTakeCareBand}
                  min={1} max={10} step={1} decimals={0}
                  unit="+°C" label={t('water temperature Take care band')}
                  onChange={band => updateCriteria({ waterTempTakeCareBelow: settings.waterTempDangerBelow + band })}
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
            <span>{t('Advanced — duration, daylight & wind sectors')}</span>
            {advancedOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>

          {advancedOpen && (
            <div className="advanced-body">

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
                    <span className="limit-hint">{t('Flag night hours as Take care')}</span>
                  </div>
                </div>
                <ToggleSwitch
                  checked={settings.daylightOnly}
                  onChange={checked => updateCriteria({ daylightOnly: checked })}
                  label={t('Daylight Only')}
                />
              </div>

              <div className={`advanced-group ${settings.enableCustomWindDirs ? '' : 'is-off'}`}>
                <div className="advanced-row">
                  <div className="advanced-row-label">
                      <Navigation size={18} className="setting-icon" />
                    <div className="limit-titles">
                      <span className="limit-name">{t('Local wind sectors')}</span>
                      <span className="limit-hint">{t('Optional stricter caps for {0}, based on broad area estimates', CURRENT_LOCATION.areaName)}</span>
                    </div>
                  </div>
                  <ToggleSwitch
                    checked={settings.enableCustomWindDirs}
                    onChange={checked => updateCriteria({ enableCustomWindDirs: checked })}
                    label={t('Apply optional FRANK wind-sector caps')}
                  />
                </div>

                {windSectors.length > 0 && (
                  <div className="sector-panel" aria-disabled={!settings.enableCustomWindDirs}>
                    <p className="sector-lead">
                      {t('These are optional FRANK estimates for a broad area, not current limits published by a kayak club. When enabled, a matching sector can only make the general wind verdict stricter.')}
                    </p>

                    <div className="sector-rose-wrap">
                      <CompassRose sectors={windSectors} />

                      <div className="sector-list">
                        {windSectors.map((sector) => {
                          const cap = sectorCap(sector);
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
                                  <span className="limit-caution-name">{t('Take care from')}</span>
                                </div>
                                <Stepper
                                  compact
                                  value={cap.takeCareAt}
                                  // Leave room for the shared minimum gap below the
                                  // 25 m/s ceiling, so both controls always remain valid.
                                  min={0} max={25 - MIN_DANGER_GAP} step={0.5} decimals={1}
                                  unit="m/s" label={t('{0} Take care threshold', t(sector.label))}
                                  onChange={takeCareAt => setSectorCap(sector, takeCareAt, cap.dangerAt)}
                                  disabled={!settings.enableCustomWindDirs}
                                />
                              </div>

                              <div className="limit-caution-row">
                                <div className="limit-caution-copy">
                                  <span className="limit-caution-name is-caution">{t('Danger from')}</span>
                                </div>
                                <Stepper
                                  compact
                                  value={floorDanger(cap.takeCareAt, cap.dangerAt)}
                                  min={cap.takeCareAt + MIN_DANGER_GAP} max={25} step={0.5} decimals={1}
                                  unit="m/s" label={t('{0} danger threshold', t(sector.label))}
                                  onChange={dangerAt => setSectorCap(sector, cap.takeCareAt, dangerAt)}
                                  disabled={!settings.enableCustomWindDirs}
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
