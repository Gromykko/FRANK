import { useState } from 'react';
import { ChevronDown, ChevronUp, Clock, Navigation, Settings, Sun, Thermometer, Waves, Wind } from 'lucide-react';
import { getWindSpeedLabel, getWaveHeightLabel } from '../features/safety/analyzeSafetyConditions';
import SafetyManualModal from './SafetyManualModal';
import CustomSelect from './CustomSelect';
import CompassRose from './CompassRose';
import type { SafetySettings } from '../hooks/useSettings';
import { floorCaution, MIN_CAUTION_GAP } from '../features/safety/presets';
import { CURRENT_LOCATION } from '../config/locations';
import type { WindSector } from '../config/locations';
import { clampNumber, roundToDecimals } from '../utils/number';
import { compassPoint, sectorMidBearing } from '../utils/compass';
import { useLang } from '../i18n';

const EXPOSURE_LABEL: Record<WindSector['exposure'], string> = {
  onshore: 'onshore',
  offshore: 'offshore',
  crossshore: 'cross-shore',
};

interface SafetyLimitsPanelProps {
  settings: SafetySettings;
  updateSettings: (settings: SafetySettings) => void;
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
      <div className="limit-value">
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
function ZoneBar({ min, max, cautionStart, cautionEnd, invert = false, leftLabel, midLabel, rightLabel }: ZoneBarProps) {
  const pct = (v: number) => clampNumber(((v - min) / (max - min)) * 100, 0, 100, 0);
  return (
    <div className="limit-zone">
      <div
        className={`zone-bar ${invert ? 'is-inverted' : ''}`}
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

export default function SafetyLimitsPanel({ settings, updateSettings }: SafetyLimitsPanelProps) {
  const { t } = useLang();
  const [isOpen, setIsOpen] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
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
    settings.sectorLimits?.[sector.id] ?? { safe: sector.safeLimit, caution: sector.cautionLimit };

  const setSectorCap = (sector: WindSector, safe: number, caution: number) => {
    updateCriteria({
      sectorLimits: {
        ...settings.sectorLimits,
        // Caution never drops below the safe cap + gap (the assessment enforces this too).
        [sector.id]: { safe, caution: floorCaution(safe, caution) },
      },
    });
  };

  const windCautionAt = settings.maxWindSpeedSafe + settings.gustMargin;
  const waveCautionAt = settings.maxWaveHeightSafe + settings.waveCautionMargin;
  const tempSafeBand = Math.max(1, Math.round(settings.minWaterTempSafe - settings.minWaterTempCaution));

  const tempHint = t(
    settings.minWaterTempCaution >= 15 ? 'Safe / Comfortable' :
    settings.minWaterTempCaution >= 10 ? 'Caution / Cold Water' : 'Danger / Cold Shock');

  const settingsPanel = (
    <div className="panel planner-settings-panel">
      {/* APG accordion header: the toggle is a real button inside the
          heading (a focusable "?" nested in a role="button" div was an
          invalid control-in-control). The row's onClick is a pointer-only
          convenience - keyboard and AT go through the title button. */}
      <div
        className={`panel-collapse-header module-head ${isOpen ? 'is-open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="settings-copy">
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
            <button
              type="button"
              className="settings-info-btn"
              onClick={(e) => {
                e.stopPropagation();
                setShowInfoModal(true);
              }}
              data-tip={t('How FRANK Decides')}
              aria-label={t('How FRANK Decides')}
            >
              ?
            </button>
          </h2>
          <span className="settings-subtitle">{t('Your personal limits')}</span>
        </span>
        <div className="settings-collapse-chevron" aria-hidden="true">
          {isOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </div>
      </div>

      {isOpen && (
        <div className="settings-body">

          <p className="settings-autosave-note">
            {t('Changes apply immediately and switch you to Custom mode. Pick a preset in the Trip Profile at the top (Chill, Normal, Pro) to go back.')}
          </p>

          <div className="limit-cards">

            {/* Wind */}
            <section className={`limit-card ${settings.enableWindSpeed ? '' : 'is-off'}`}>
              <div className="limit-head">
                <div className="limit-id">
                  <Wind size={20} className={`setting-icon ${settings.maxWindSpeedSafe >= 10 ? 'is-danger' : settings.maxWindSpeedSafe >= 6 ? 'is-caution' : ''}`} />
                  <div className="limit-titles">
                    <span className="limit-name">{t('Max Wind')}</span>
                    <span className="limit-hint">{t(getWindSpeedLabel(settings.maxWindSpeedSafe))}</span>
                  </div>
                </div>
                <ToggleSwitch
                  checked={settings.enableWindSpeed}
                  onChange={checked => updateCriteria({ enableWindSpeed: checked })}
                  label={t('Max wind limit enabled')}
                />
              </div>
              <Stepper
                value={settings.maxWindSpeedSafe}
                min={0} max={25} step={0.5} decimals={1}
                unit={t('m/s wind')} label={t('max wind')}
                onChange={val => updateCriteria({ maxWindSpeedSafe: val, maxWindSpeedCaution: val + settings.gustMargin })}
                disabled={!settings.enableWindSpeed}
              />
              <ZoneBar
                min={0} max={20}
                cautionStart={settings.maxWindSpeedSafe}
                cautionEnd={windCautionAt}
                leftLabel={t('0 calm')}
                midLabel={t('caution to {0}', windCautionAt.toFixed(1))}
                rightLabel={t('20+ gale')}
              />
              <div className={`limit-caution-row ${settings.enableWindSpeed && settings.enableWindGust ? '' : 'is-off'}`}>
                <ToggleSwitch
                  small
                  checked={settings.enableWindSpeed && settings.enableWindGust}
                  onChange={checked => updateCriteria({ enableWindGust: checked })}
                  label={t('Wind gust margin enabled')}
                  disabled={!settings.enableWindSpeed}
                />
                <div className="limit-caution-copy">
                  <span className="limit-caution-name">{t('Gust margin')}</span>
                  <span className="limit-caution-hint">{t('gusts up to {0} m/s rate Caution', windCautionAt.toFixed(1))}</span>
                </div>
                <Stepper
                  compact
                  value={settings.gustMargin}
                  min={1} max={10} step={0.5} decimals={1}
                  unit="+m/s" label={t('gust margin')}
                  onChange={margin => updateCriteria({ gustMargin: margin, maxWindSpeedCaution: settings.maxWindSpeedSafe + margin })}
                  disabled={!settings.enableWindSpeed || !settings.enableWindGust}
                />
              </div>
            </section>

            {/* Waves */}
            <section className={`limit-card ${settings.enableWaveHeight ? '' : 'is-off'}`}>
              <div className="limit-head">
                <div className="limit-id">
                  <Waves size={20} className={`setting-icon ${settings.maxWaveHeightSafe >= 1.0 ? 'is-danger' : settings.maxWaveHeightSafe >= 0.5 ? 'is-caution' : ''}`} />
                  <div className="limit-titles">
                    <span className="limit-name">{t('Max Wave')}</span>
                    <span className="limit-hint">{t(getWaveHeightLabel(settings.maxWaveHeightSafe))}</span>
                  </div>
                </div>
                <ToggleSwitch
                  checked={settings.enableWaveHeight}
                  onChange={checked => updateCriteria({ enableWaveHeight: checked })}
                  label={t('Max wave limit enabled')}
                />
              </div>
              <Stepper
                value={settings.maxWaveHeightSafe}
                min={0.1} max={3.0} step={0.05} decimals={2}
                unit={t('m waves')} label={t('max wave')}
                onChange={val => updateCriteria({ maxWaveHeightSafe: val, maxWaveHeightCaution: val + settings.waveCautionMargin })}
                disabled={!settings.enableWaveHeight}
              />
              <ZoneBar
                min={0} max={1.5}
                cautionStart={settings.maxWaveHeightSafe}
                cautionEnd={waveCautionAt}
                leftLabel={t('0 flat')}
                midLabel={t('caution to {0}', waveCautionAt.toFixed(2))}
                rightLabel={t('1.5+ rough')}
              />
              <div className={`limit-caution-row ${settings.enableWaveHeight && settings.enableWaveCaution ? '' : 'is-off'}`}>
                <ToggleSwitch
                  small
                  checked={settings.enableWaveHeight && settings.enableWaveCaution}
                  onChange={checked => updateCriteria({ enableWaveCaution: checked })}
                  label={t('Wave caution margin enabled')}
                  disabled={!settings.enableWaveHeight}
                />
                <div className="limit-caution-copy">
                  <span className="limit-caution-name">{t('Caution margin')}</span>
                  <span className="limit-caution-hint">{t('waves up to {0} m rate Caution', waveCautionAt.toFixed(2))}</span>
                </div>
                <Stepper
                  compact
                  value={settings.waveCautionMargin}
                  min={0.05} max={2.0} step={0.05} decimals={2}
                  unit="+m" label={t('wave caution margin')}
                  onChange={margin => updateCriteria({ waveCautionMargin: margin, maxWaveHeightCaution: settings.maxWaveHeightSafe + margin })}
                  disabled={!settings.enableWaveHeight || !settings.enableWaveCaution}
                />
              </div>
            </section>

            {/* Water temperature */}
            <section className={`limit-card ${settings.enableWaterTemp ? '' : 'is-off'}`}>
              <div className="limit-head">
                <div className="limit-id">
                  <Thermometer size={20} className={`setting-icon ${settings.minWaterTempCaution >= 15 ? 'is-safe' : settings.minWaterTempCaution >= 10 ? 'is-caution' : 'is-danger'}`} />
                  <div className="limit-titles">
                    <span className="limit-name">{t('Min Water Temp')}</span>
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
                value={settings.minWaterTempCaution}
                min={5} max={20} step={1} decimals={0}
                unit={t('°C water')} label={t('min water temperature')}
                onChange={val => updateCriteria({ minWaterTempCaution: val, minWaterTempSafe: val + tempSafeBand })}
                disabled={!settings.enableWaterTemp}
              />
              <ZoneBar
                min={0} max={25}
                invert
                cautionStart={settings.minWaterTempCaution}
                cautionEnd={settings.minWaterTempSafe}
                leftLabel={t('0 ice')}
                midLabel={t('safe from {0}°', settings.minWaterTempSafe)}
                rightLabel={t('25 summer')}
              />
              <div className="limit-caution-row">
                <div className="limit-caution-copy">
                  <span className="limit-caution-name">{t('Caution band')}</span>
                  <span className="limit-caution-hint">{t('{0}–{1} °C asks for thermal wear', settings.minWaterTempCaution, settings.minWaterTempSafe)}</span>
                </div>
                <Stepper
                  compact
                  value={tempSafeBand}
                  min={1} max={10} step={1} decimals={0}
                  unit="+°C" label={t('water temperature caution band')}
                  onChange={band => updateCriteria({ minWaterTempSafe: settings.minWaterTempCaution + band })}
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
            <span>{t('Advanced — duration, water level, daylight & wind sectors')}</span>
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
                  <Navigation size={18} className="setting-icon" />
                  <div className="limit-titles">
                    <span className="limit-name">{t('Water level')}</span>
                    <span className="limit-hint">{t('Preferred water level for launching')}</span>
                  </div>
                </div>
                <CustomSelect
                  value={settings.tidePreference}
                  onChange={val => updateCriteria({ tidePreference: val })}
                  options={[
                    { value: 'any', label: t('Any Level') },
                    { value: 'high', label: t('High Water') },
                    { value: 'low', label: t('Low Water') },
                    { value: 'incoming', label: t('Rising') }
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
                      <span className="limit-hint">{t('Stricter caps for {0}, plus wind-against-water-level chop', CURRENT_LOCATION.areaName)}</span>
                    </div>
                  </div>
                  <ToggleSwitch
                    checked={settings.enableCustomWindDirs}
                    onChange={checked => updateCriteria({ enableCustomWindDirs: checked })}
                    label={t('Apply local wind-sector caps')}
                  />
                </div>

                {settings.enableCustomWindDirs && windSectors.length > 0 && (
                  <div className="sector-panel">
                    <p className="sector-lead">
                      {t('Wind from these directions is rougher here than its speed alone suggests, so FRANK caps them tighter.')}
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
                                <span className={`sector-chip exposure-${sector.exposure}`}>{t(EXPOSURE_LABEL[sector.exposure])}</span>
                                <span className="sector-bearing">{t('from {0}', bearing)}</span>
                              </span>
                              <p className="limit-hint">{t(sector.description)}</p>

                              <div className="limit-caution-row">
                                <div className="limit-caution-copy">
                                  <span className="limit-caution-name">{t('Safe cap')}</span>
                                </div>
                                <Stepper
                                  compact
                                  value={cap.safe}
                                  min={0} max={25} step={0.5} decimals={1}
                                  unit="m/s" label={t('{0} safe cap', t(sector.label))}
                                  onChange={val => setSectorCap(sector, val, cap.caution)}
                                />
                              </div>

                              <div className="limit-caution-row">
                                <div className="limit-caution-copy">
                                  <span className="limit-caution-name is-caution">{t('Danger cap')}</span>
                                </div>
                                <Stepper
                                  compact
                                  value={floorCaution(cap.safe, cap.caution)}
                                  min={cap.safe + MIN_CAUTION_GAP} max={25} step={0.5} decimals={1}
                                  unit="m/s" label={t('{0} danger cap', t(sector.label))}
                                  onChange={val => setSectorCap(sector, cap.safe, val)}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <p className="sector-note">
                      {t('Directions are fixed to the local geography. Only the wind speeds are yours.')}
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
          onClose={() => setShowInfoModal(false)}
        />
      )}
    </>
  );
}
