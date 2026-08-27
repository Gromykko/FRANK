// Primary sources cited by the in-app profile explanation and safety manual.
// Keep the evidence close to the claims: DKF Touring supplies the numeric IPP3
// and IPP4 wind anchors; the current DKF sea-kayak norm supplies the IPP2 wind
// ceiling and numeric wave ceilings. DMI/MET define the forecast measurements,
// and WMO supplies the supplemental sea-wave terms.
export const SAFETY_GUIDANCE_SOURCES = {
  dkfTouring: 'https://www.kano-kajak.dk/uddannelse-og-kurser/ipp-roeruddannelse/touring-tur/',
  dkfIpp3Touring: 'https://drive.google.com/file/d/14lUb_7t5ZV1vp49sOBmCmlXuOnSWmQMX/view?usp=sharing',
  dkfIpp4Touring: 'https://drive.google.com/file/d/1iagdhW-B3ZXvHUmEBSfxVESyne5qevb2/view?usp=sharing',
  dkfSeaKayakNorm: 'https://drive.google.com/file/d/1YoO6StJ_nfwx2kb9X7lyH5y4gFQqp1O5/view?usp=drive_link',
  dmiBeaufort: 'https://www.dmi.dk/vejr-og-atmosfare/temaforside-vind/beaufortskalaen/',
  dmiForecastVocabulary: 'https://www.dmi.dk/nyheder/2019/faa-det-store-koerekort-til-vejrudsigten/',
  dmiSignificantWaveHeight: 'https://www.dmi.dk/hav-og-is/temaforside-monsterbolger/bolger-pa-havet',
  metForecastDataModel: 'https://docs.api.met.no/doc/locationforecast/datamodel.html',
  metWeatherSymbolLegend: 'https://raw.githubusercontent.com/metno/weathericons/main/weather/legend.csv',
  wmoSeaStateTerminology: 'https://community.wmo.int/site/knowledge-hub/programmes-and-initiatives/marine-services/frequently-asked-questions',
} as const;

export const GUIDED_PROFILE_MODES = [
  { mode: 'beginner', label: 'Chill', level: 'IPP 2' },
  { mode: 'default', label: 'Normal', level: 'IPP 3' },
  { mode: 'pro', label: 'Pro', level: 'IPP 4' },
] as const;
