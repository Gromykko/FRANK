import type { SafetySettings } from './presets';
import type { SafetyAnalysis, SafetyRating, SafetyReason } from './analyzeSafetyConditions';

export interface SafetyDisplay {
  rating: SafetyRating;
  reasons: SafetyReason[];
  // True only when raw mode turns an otherwise-safe analysis into the generic
  // "limits are off" caution. Weather hazards never take this fallback path.
  usesLimitsOffFallback: boolean;
}

// Weather is deliberately absent: MET's condition severity is always assessed
// by analyzeSafetyConditions. These are only the configurable/personal rules.
export function hasActiveSafetyChecks(settings: SafetySettings): boolean {
  return [
    settings.enableWindSpeed,
    settings.enableWindSpeed && settings.enableWindGust,
    settings.enableWaveHeight,
    settings.enableWaveHeight && settings.enableWaveCaution,
    settings.enableWaterTemp,
    settings.enableCustomWindDirs,
    settings.daylightOnly,
  ].some(Boolean);
}

export function getSafetyDisplay(
  analysis: SafetyAnalysis,
  activeSafetyChecks: boolean,
  limitsOffText: string,
): SafetyDisplay {
  if (activeSafetyChecks) {
    return {
      rating: analysis.rating,
      reasons: analysis.reasons,
      usesLimitsOffFallback: false,
    };
  }

  const limitsOffReason: SafetyReason = {
    text: limitsOffText,
    severity: 'caution',
  };

  if (analysis.rating === 'safe') {
    return {
      rating: 'caution',
      reasons: [limitsOffReason],
      usesLimitsOffFallback: true,
    };
  }

  // Thunder, heavy precipitation, fog and other non-configurable weather
  // hazards remain authoritative even when every personal limit is disabled.
  // Keep their exact analyzer reasons, then state separately that personal
  // thresholds are off so the user understands the scope of the verdict.
  return {
    rating: analysis.rating,
    reasons: [...analysis.reasons, limitsOffReason],
    usesLimitsOffFallback: false,
  };
}

export function withSafetyInfoDisclosure(
  display: SafetyDisplay,
  text: string | null | undefined,
): SafetyDisplay {
  if (!text) return display;
  // Presentation-only provenance is appended after every verdict decision,
  // including the limits-off fallback. It cannot replace or escalate a reason.
  return {
    ...display,
    reasons: [...display.reasons, { severity: 'info', text }],
  };
}
