import type { SafetySettings } from './presets';
import type { DisplayStatus, SafetyAnalysis, SafetyReason } from './analyzeSafetyConditions';

export interface SafetyDisplay {
  // DisplayStatus, not SafetyRating: with every check off there is no verdict
  // to show, and 'none' is how the matrix and the reasons render grey.
  rating: DisplayStatus;
  reasons: SafetyReason[];
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
    };
  }

  const limitsOffReason: SafetyReason = {
    text: limitsOffText,
    severity: 'none',
  };

  // With nothing to judge against, FRANK reports and does not advise. Every
  // hour is 'none' rather than amber: the previous fallback rated a calm hour
  // 'caution', so a mode that applies no limits still painted the whole matrix
  // cautionary - neither a verdict nor useful information.
  //
  // Weather hazards remain VISIBLE but as observations. "Heavy rain" is a fact
  // and belongs on a weather display; "probably one to skip" is advice, and
  // advice is exactly what was switched off. Withholding the fact would be a
  // different thing from withholding the judgement.
  return {
    rating: 'none',
    reasons: [
      ...(analysis.weatherFact
        ? [{ text: analysis.weatherFact, severity: 'none' as const }]
        : []),
      limitsOffReason,
    ],
  };
}
