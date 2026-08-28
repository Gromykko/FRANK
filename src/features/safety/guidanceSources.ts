// Primary sources cited by the in-app profile explanation and safety manual.
// Keep the evidence close to the claims: DKF Touring supplies the numeric IPP3
// and IPP4 wind anchors; the current DKF sea-kayak norm supplies the IPP2 wind
// ceiling and numeric wave ceilings. DMI/MET define the forecast measurements,
// NWS supplies the official kayak-facing sustained-wind-or-gust precedent, and
// WMO supplies the supplemental sea-wave terms. RNLI and Søsportens
// Sikkerhedsråd supply the two default cold-water boundaries.
export const SAFETY_GUIDANCE_SOURCES = {
  dkfTouring: 'https://www.kano-kajak.dk/uddannelse-og-kurser/ipp-roeruddannelse/touring-tur/',
  dkfIpp3Touring: 'https://drive.google.com/file/d/14lUb_7t5ZV1vp49sOBmCmlXuOnSWmQMX/view?usp=sharing',
  dkfIpp4Touring: 'https://drive.google.com/file/d/1iagdhW-B3ZXvHUmEBSfxVESyne5qevb2/view?usp=sharing',
  dkfSeaKayakNorm: 'https://drive.google.com/file/d/1YoO6StJ_nfwx2kb9X7lyH5y4gFQqp1O5/view?usp=drive_link',
  dmiBeaufort: 'https://www.dmi.dk/vejr-og-atmosfare/temaforside-vind/beaufortskalaen/',
  dmiForecastVocabulary: 'https://www.dmi.dk/nyheder/2019/faa-det-store-koerekort-til-vejrudsigten/',
  dmiSignificantWaveHeight: 'https://www.dmi.dk/hav-og-is/temaforside-monsterbolger/bolger-pa-havet',
  dmiForecastEdr: 'https://www.dmi.dk/friedata/dokumentation/forecast-data-edr-api',
  metForecastDataModel: 'https://docs.api.met.no/doc/locationforecast/datamodel.html',
  metLocationForecastFaq: 'https://docs.api.met.no/doc/locationforecast/FAQ.html',
  nwsKayakWindHazards: 'https://www.weather.gov/mqt/Local_Marine',
  rnliColdWater: 'https://rnli.org/water-safety/know-the-risks/cold-water-shock',
  danishColdWaterSafety: 'https://www.soesport.dk/redning-og-sikkerhed/kulde-og-beklaedning',
  metWeatherSymbolLegend: 'https://raw.githubusercontent.com/metno/weathericons/main/weather/legend.csv',
  wmoSeaStateTerminology: 'https://community.wmo.int/site/knowledge-hub/programmes-and-initiatives/marine-services/frequently-asked-questions',
} as const;

export const TRIP_PROFILE_LABELS = {
  beginner: 'Chill',
  default: 'Medium',
  pro: 'Pro',
  custom: 'Custom',
} as const;

export const GUIDED_PROFILE_MODES = [
  { mode: 'beginner', label: TRIP_PROFILE_LABELS.beginner, level: 'IPP 2' },
  { mode: 'default', label: TRIP_PROFILE_LABELS.default, level: 'IPP 3' },
  { mode: 'pro', label: TRIP_PROFILE_LABELS.pro, level: 'IPP 4' },
] as const;
