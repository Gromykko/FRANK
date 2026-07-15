// Danish dictionary. Keys are the FULL English source strings (readable call
// sites; a missing entry soft-fails to English). {0}/{1}… are argument slots.
// Organized by the component/module the strings live in.
export const da: Record<string, string> = {
  // ── Shared verdict & rating words ──────────────────────────────────────────
  'Good to go': 'Klar til at ro',
  'Take care': 'Pas på',
  'Rough': 'Bliv i land',
  'safe': 'sikker',
  'caution': 'pas på',
  'danger': 'fare',
  'rising': 'stigende',
  'falling': 'faldende',
  'and': 'og',

  // Compass points (8-point rose + rose labels; N and S are identical)
  'NE': 'NØ',
  'E': 'Ø',
  'SE': 'SØ',
  'SW': 'SV',
  'W': 'V',
  'NW': 'NV',

  // ── App.tsx: loaders, badges, warnings, sections, footer ──────────────────
  'Analysing {0} marine forecast...': 'Analyserer havprognosen for {0}...',
  "Can't reach the forecast right now": 'Kan ikke nå prognosen lige nu',
  'Try Again': 'Prøv igen',
  'Preparing forecast dashboard...': 'Forbereder prognoseoversigten...',
  'Weather': 'Vejr',
  'Limits are off — raw forecast only': 'Grænserne er slået fra — kun rå prognose',
  'Have fun out there': 'God tur derude',
  'Keep an eye out': 'Hold øje undervejs',
  'Maybe skip today': 'Måske en dag at springe over',
  'Your personal limits are off. Use the raw forecast values and local judgement before launching.':
    'Dine personlige grænser er slået fra. Brug de rå prognosetal og lokal dømmekraft, før du tager på vandet.',
  'Limits are off. You are the captain now': 'Grænserne er slået fra. Du er kaptajnen nu',
  'Switch to dark theme': 'Skift til mørkt tema',
  'Switch to light theme': 'Skift til lyst tema',
  'built {0}': 'bygget {0}',
  '{0} is a provisional location — its wind sectors and caps are placeholders, not locally calibrated. Verify with a local paddler before trusting the verdict.':
    '{0} er et foreløbigt sted — dets vindsektorer og lofter er pladsholdere, ikke lokalt kalibreret. Bekræft med en lokal roer, før du stoler på vurderingen.',
  'The forecast is briefly out of date while FRANK updates behind the scenes. Please check back in a few minutes.':
    'Prognosen er kortvarigt forældet, mens FRANK opdaterer i baggrunden. Kig tilbage om et par minutter.',
  "{0} has been busy for a while, so the forecast hasn't updated since {1}. FRANK keeps retrying automatically — you are seeing the last good forecast.":
    '{0} har været optaget et stykke tid, så prognosen er ikke opdateret siden {1}. FRANK prøver igen automatisk — du ser den seneste gode prognose.',
  'Forecast refresh keeps failing (last try {0}). You are seeing data from {1} — {2} old, so treat it with extra caution.{3} FRANK retries by itself roughly every 10 minutes.':
    'Prognoseopdateringen fejler fortsat (sidste forsøg {0}). Du ser data fra {1} — {2} gamle, så brug dem med ekstra forsigtighed.{3} FRANK prøver selv igen cirka hvert 10. minut.',
  'Hourly forecast timeline': 'Timeprognosens tidslinje',
  'Detailed Graphs': 'Detaljerede grafer',
  'Wind, waves, water level, and temperature': 'Vind, bølger, vandstand og temperatur',
  'Loading charts...': 'Indlæser grafer...',
  'Weather data by MET Norway': 'Vejrdata fra MET Norway',
  ', waves & water by DMI ({0}) for {1}.': ', bølger & vandstand fra DMI ({0}) for {1}.',
  'Warnings by': 'Varsler fra',
  'Forecast built {0}. Worker checked {1}.': 'Prognose bygget {0}. Server tjekket {1}.',

  // useForecast error strings (shown via t(error))
  'No forecast data is available yet.': 'Der er ingen prognosedata endnu.',
  'Could not reach the forecast service — showing the last saved forecast.':
    'Kunne ikke nå prognosetjenesten — viser den senest gemte prognose.',
  'Could not refresh forecast data. Showing the latest cached forecast if available.':
    'Kunne ikke opdatere prognosen. Viser den senest gemte prognose, hvis den findes.',

  // ── StatusBar ──────────────────────────────────────────────────────────────
  '{0}. {1}. FRANK says: {2}.': '{0}. {1}. FRANK siger: {2}.',
  'Refresh forecast': 'Opdater prognosen',
  // The flag button shows the CURRENT language; its label names the switch
  // action — so the Danish rendering is "switch to English".
  'Switch to Danish': 'Skift til engelsk',

  // ── FRANK's dot-matrix phrases ─────────────────────────────────────────────
  'Good weather, go ahead!': 'Godt vejr — af sted med dig!',
  'The {0} looks fint. Off you go': '{0} ser fin ud. Af sted',
  'Smooth as smørrebrød out there': 'Glat som smørrebrød derude',
  'Even the herring approve today': 'Selv sildene godkender i dag',
  'Grab the paddle before the weather changes its mind': 'Grib pagajen, før vejret ombestemmer sig',
  'No bad weather, only bad clothing': 'Der findes ikke dårligt vejr, kun dårligt tøj',
  'The {0} is in a mood today': '{0} er i dårligt humør i dag',
  'Borderline. Very Jutland of it': 'På grænsen. Meget jysk af den',
  'Manageable — keep a cool head': 'Til at klare — hold hovedet koldt',
  'Fine to go, but stay near the shore': 'Fint at tage ud, men hold dig tæt på kysten',
  'Nej tak. The {0} says no': 'Nej tak. {0} siger nej',
  'Even the Vikings called in sick today': 'Selv vikingerne har meldt sig syge i dag',
  'The {0} will still be here tomorrow': '{0} er her også i morgen',
  'The sea is angry. Coffee instead': 'Havet er vredt. Kaffe i stedet',
  'Not today. FRANK insists': 'Ikke i dag. FRANK insisterer',
  'Best enjoyed from the shore today': 'Nydes bedst fra land i dag',

  // ── Cache status (cacheStatusView.ts) ─────────────────────────────────────
  'Offline': 'Offline',
  'Showing your saved forecast from {0}': 'Viser din gemte prognose fra {0}',
  'Showing your saved forecast': 'Viser din gemte prognose',
  'Weather service': 'Vejrtjenesten',
  'Waves & water service': 'Bølge- og vandstandstjenesten',
  'Forecast services': 'Prognosetjenesterne',
  'weather': 'vejr',
  'waves & water': 'bølger & vandstand',
  'weather, waves & water': 'vejr, bølger & vandstand',
  'services': 'tjenesterne',
  'weather service': 'vejrtjenesten',
  'marine service': 'havtjenesten',
  'Refreshing…': 'Opdaterer…',
  'Checking…': 'Tjekker…',
  '{0} busy': '{0} er optaget',
  'Couldn’t refresh': 'Kunne ikke opdatere',
  'Checked · {0}': 'Tjekket · {0}',
  'Retrying automatically · checked {0}': 'Prøver igen automatisk · tjekket {0}',
  'Showing earlier data · last try {0}': 'Viser ældre data · sidste forsøg {0}',
  '{0} from an earlier update · {1} busy': '{0} fra en tidligere opdatering · {1} er optaget',
  '{0} from an earlier update · couldn’t refresh just now': '{0} fra en tidligere opdatering · kunne ikke opdatere lige nu',
  '{0} min': '{0} min',
  '{0} h': '{0} t',
  '{0} d': '{0} d',
  "You're offline, so FRANK is showing your last saved forecast from {0}. It will refresh on its own once you're back online.":
    'Du er offline, så FRANK viser din senest gemte prognose fra {0}. Den opdateres af sig selv, når du er online igen.',
  '{0} is busy right now, so the forecast could not be refreshed. FRANK is retrying automatically; you are seeing the last good forecast from {1}.':
    '{0} er optaget lige nu, så prognosen kunne ikke opdateres. FRANK prøver igen automatisk; du ser den seneste gode prognose fra {1}.',
  'The forecast could not be refreshed on the last try ({0}); FRANK is retrying automatically. You are seeing the last good forecast from {1}.':
    'Prognosen kunne ikke opdateres ved sidste forsøg ({0}); FRANK prøver igen automatisk. Du ser den seneste gode prognose fra {1}.',
  'Forecast from {0}; {1} is from an earlier update while its service was busy. FRANK is retrying automatically.':
    'Prognose fra {0}; {1} er fra en tidligere opdatering, mens tjenesten var optaget. FRANK prøver igen automatisk.',
  'Forecast from {0}; {1} is from an earlier update (could not refresh just now). FRANK is retrying automatically.':
    'Prognose fra {0}; {1} er fra en tidligere opdatering (kunne ikke opdatere lige nu). FRANK prøver igen automatisk.',
  'Checking for a newer forecast': 'Tjekker efter en nyere prognose',
  'Forecast from {0}; cache checked {1}': 'Prognose fra {0}; cache tjekket {1}',
  'Forecast from {0}': 'Prognose fra {0}',
  ' Last issue: {0}': ' Seneste fejl: {0}',

  // ── Safety reasons (analyzeSafetyConditions.ts) ───────────────────────────
  'Wind speed: {0} m/s ({1}). Exceeds your danger limit of {2} m/s.':
    'Vindstyrke: {0} m/s ({1}). Over din faregrænse på {2} m/s.',
  'Wind speed: {0} m/s ({1}). Exceeds your safe limit of {2} m/s.':
    'Vindstyrke: {0} m/s ({1}). Over din sikre grænse på {2} m/s.',
  'Wind gusts: {0} m/s ({1}). Above your gust ceiling of {2} m/s.':
    'Vindstød: {0} m/s ({1}). Over dit vindstødsloft på {2} m/s.',
  'Wind gusts: {0} m/s ({1}). Exceeds your safe limit of {2} m/s.':
    'Vindstød: {0} m/s ({1}). Over din sikre grænse på {2} m/s.',
  '{0} wind ({1}°) is over your {2} m/s danger cap for this direction.':
    '{0} vind ({1}°) er over dit fareloft på {2} m/s for denne retning.',
  '{0} wind ({1}°) is over your {2} m/s safe cap for this direction.':
    '{0} vind ({1}°) er over dit sikre loft på {2} m/s for denne retning.',
  'Wind-against-water-level conflict: wind opposes {0} water level. Expect steeper chop.':
    'Vind mod vandstand: vinden går imod {0} vandstand. Forvent mere krap sø.',
  "Water temperature: {0}°C — colder than your danger limit of {1}°C. You'd really want a drysuit or heavy thermals for this.":
    'Vandtemperatur: {0}°C — koldere end din faregrænse på {1}°C. Her vil du virkelig ønske dig en tørdragt eller tykt termotøj.',
  'Water temperature: {0}°C — under your safe limit of {1}°C. Worth layering up.':
    'Vandtemperatur: {0}°C — under din sikre grænse på {1}°C. Tag et ekstra lag på.',
  'Wave height: {0} m ({1}). Exceeds your danger limit of {2} m.':
    'Bølgehøjde: {0} m ({1}). Over din faregrænse på {2} m.',
  'Wave height: {0} m ({1}). Exceeds your safe limit of {2} m.':
    'Bølgehøjde: {0} m ({1}). Over din sikre grænse på {2} m.',
  // "At your limit" variants — used when the reading rounds exactly onto the
  // limit, so it doesn't read as a confusing "0,20 overstiger 0,2".
  'Wind speed: {0} m/s ({1}). At your danger limit of {2} m/s.':
    'Vindstyrke: {0} m/s ({1}). På din faregrænse på {2} m/s.',
  'Wind speed: {0} m/s ({1}). At your safe limit of {2} m/s.':
    'Vindstyrke: {0} m/s ({1}). På din sikre grænse på {2} m/s.',
  'Wind gusts: {0} m/s ({1}). At your gust ceiling of {2} m/s.':
    'Vindstød: {0} m/s ({1}). På dit vindstødsloft på {2} m/s.',
  'Wind gusts: {0} m/s ({1}). At your safe limit of {2} m/s.':
    'Vindstød: {0} m/s ({1}). På din sikre grænse på {2} m/s.',
  '{0} wind ({1}°) is at your {2} m/s danger cap for this direction.':
    '{0} vind ({1}°) er på dit fareloft på {2} m/s for denne retning.',
  '{0} wind ({1}°) is at your {2} m/s safe cap for this direction.':
    '{0} vind ({1}°) er på dit sikre loft på {2} m/s for denne retning.',
  'Wave height: {0} m ({1}). At your danger limit of {2} m.':
    'Bølgehøjde: {0} m ({1}). På din faregrænse på {2} m.',
  'Wave height: {0} m ({1}). At your safe limit of {2} m.':
    'Bølgehøjde: {0} m ({1}). På din sikre grænse på {2} m.',
  '{0} — rough out there, probably one to skip.': '{0} — barskt derude, nok en dag at springe over.',
  '{0} — worth keeping an eye on.': '{0} — værd at holde øje med.',
  'Nighttime: outside sunrise-to-sunset paddling hours.': 'Nat: uden for rotimerne mellem solopgang og solnedgang.',
  "Everything's within your limits — {0}, {1}, {2}.": 'Alt er inden for dine grænser — {0}, {1}, {2}.',
  'calm water': 'roligt vand',
  'small ripples': 'små krusninger',
  'choppy water': 'krap sø',
  'rough water': 'urolig sø',
  'very rough water': 'meget urolig sø',

  // Beaufort-style wind labels
  'Calm': 'Stille',
  'Light Air': 'Næsten stille',
  'Light Breeze': 'Svag vind',
  'Gentle Breeze': 'Let vind',
  'Moderate Breeze': 'Jævn vind',
  'Fresh Breeze': 'Frisk vind',
  'Strong Breeze': 'Hård vind',
  'Near Gale': 'Stiv kuling',
  'Gale': 'Hård kuling',
  'Strong Gale': 'Stormende kuling',
  'Storm': 'Storm',

  // Wave height labels
  'Flat / Calm': 'Spejlblankt / Roligt',
  'Smooth / Small Ripples': 'Glat / Små krusninger',
  'Slight / Choppy': 'Let sø / Krap sø',
  'Moderate / Rough': 'Moderat sø / Urolig sø',
  'Very Rough / High': 'Meget urolig / Høj sø',

  // ── Weather code descriptions (weatherCodes.ts, translated at display) ────
  'Clear sky': 'Skyfrit',
  'Mainly clear': 'Overvejende klart',
  'Partly cloudy': 'Delvist skyet',
  'Overcast': 'Overskyet',
  'Fog': 'Tåge',
  'Depositing rime fog': 'Rimtåge',
  'Light drizzle': 'Let støvregn',
  'Moderate drizzle': 'Moderat støvregn',
  'Dense drizzle': 'Tæt støvregn',
  'Light freezing drizzle': 'Let frysende støvregn',
  'Dense freezing drizzle': 'Tæt frysende støvregn',
  'Slight rain': 'Let regn',
  'Moderate rain': 'Moderat regn',
  'Heavy rain': 'Kraftig regn',
  'Light freezing rain': 'Let isslag',
  'Heavy freezing rain': 'Kraftigt isslag',
  'Slight snow fall': 'Let snefald',
  'Moderate snow fall': 'Moderat snefald',
  'Heavy snow fall': 'Kraftigt snefald',
  'Snow grains': 'Snekorn',
  'Slight rain showers': 'Lette regnbyger',
  'Moderate rain showers': 'Moderate regnbyger',
  'Violent rain showers': 'Voldsomme regnbyger',
  'Slight snow showers': 'Lette snebyger',
  'Heavy snow showers': 'Kraftige snebyger',
  'Thunderstorm risk': 'Risiko for tordenvejr',
  'Thunderstorm with slight hail': 'Tordenvejr med let hagl',
  'Thunderstorm with heavy hail': 'Tordenvejr med kraftig hagl',
  'Unknown weather': 'Ukendt vejr',

  // ── ConditionsSnapshot ────────────────────────────────────────────────────
  'Current conditions': 'Aktuelle forhold',
  'Air': 'Luft',
  'Wind': 'Vind',
  'Waves': 'Bølger',
  'Water': 'Vand',
  // "Niveau" not "Vandstand": the long label pushed the block range value
  // ("-0.01 til +0.33 m") into the sunrise/sunset cell on 390px phones.
  'Level': 'Niveau',
  'gusts {0}': 'vindstød {0}',
  'gusts {0} max': 'vindstød {0} maks',
  '{0} to {1} m': '{0} til {1} m',
  'Wind from {0}. The arrow points downwind (where the wind is heading).':
    'Vind fra {0}. Pilen peger med vinden (derhen hvor vinden blæser).',
  'Long range outlook · lower confidence': 'Langtidsudsigt · lavere sikkerhed',
  'Overall rating: {0}.': 'Samlet vurdering: {0}.',
  'Conditions for {0}:': 'Forhold for {0}:',

  // ── TimelineBar ───────────────────────────────────────────────────────────
  'Today': 'I dag',
  'Wind direction, speed, and gusts (m/s)': 'Vindretning, -styrke og vindstød (m/s)',
  'Wave Height (m)': 'Bølgehøjde (m)',
  'Water level (m)': 'Vandstand (m)',
  'Air temperature (°C)': 'Lufttemperatur (°C)',
  'Water temperature (°C)': 'Vandtemperatur (°C)',
  'Forecast hours': 'Prognosetimer',
  '(Night)': '(Nat)',
  '(Longer range, lower confidence)': '(Længere sigt, lavere sikkerhed)',

  // ── PaddlePlanner ─────────────────────────────────────────────────────────
  'Available Launch Windows': 'Ledige rovinduer',
  'Launch window view': 'Visning af rovinduer',
  'List': 'Liste',
  'Calendar': 'Kalender',
  'No windows match your criteria — there are safe hours, but not a long enough run for your minimum duration and water-level preference. Try another trip mode or loosen the Advanced settings.':
    'Ingen vinduer matcher dine kriterier — der er sikre timer, men ikke et langt nok forløb til din minimumsvarighed og vandstandspræference. Prøv en anden turprofil, eller løsn de avancerede indstillinger.',
  'No good windows in the forecast yet — conditions stay above your limits for now. Check back as it updates.':
    'Ingen gode vinduer i prognosen endnu — forholdene ligger over dine grænser for nu. Kig tilbage, når den opdateres.',
  '{0} hr': '{0} time',
  '{0} hrs': '{0} timer',
  'outlook': 'udsigt',
  'Outlook window, roughly {0}:00 to {1}:00 — longer range, lower confidence':
    'Udsigtsvindue, cirka {0}:00 til {1}:00 — længere sigt, lavere sikkerhed',
  'Launch window {0}:00 to {1}:00, {2}': 'Rovindue {0}:00 til {1}:00, {2}',
  ', partly outside daylight': ', delvist uden for dagslys',
  'no launch windows': 'ingen rovinduer',
  'Copy the launch window details:': 'Kopiér rovinduets detaljer:',
  '{0}: {1} {2}–{3}. Wind {4} m/s, waves {5} m.': '{0}: {1} {2}–{3}. Vind {4} m/s, bølger {5} m.',
  '{0} m/s wind · {1} m waves': '{0} m/s vind · {1} m bølger',
  'Ends near sunset ({0})': 'Slutter nær solnedgang ({0})',
  "A DMI {0} warning for {1} overlaps this window — it doesn't change this window's verdict; see the warning banner and DMI for details":
    '{0} DMI-varsel for {1} overlapper dette vindue — det ændrer ikke vinduets vurdering; se varselsbanneret og DMI for detaljer',
  'Longer-range outlook — lower confidence.': 'Langtidsudsigt — lavere sikkerhed.',
  'Tap to show this window in the graph.': 'Tryk for at vise dette vindue i grafen.',
  'Share this launch window': 'Del dette rovindue',
  'Launch window': 'Rovindue',
  'Outlook (lower confidence)': 'Udsigt (lavere sikkerhed)',
  'Night': 'Nat',
  'Now': 'Nu',
  'No launch windows in this forecast — the timeline above shows the marginal hours.':
    'Ingen rovinduer i denne prognose — tidslinjen ovenfor viser de marginale timer.',
  'Launch windows by day, {0} days': 'Rovinduer pr. dag, {0} dage',

  // ── WeatherCharts ─────────────────────────────────────────────────────────
  'Your limits: on': 'Dine grænser: til',
  'Your limits: off': 'Dine grænser: fra',
  'Tap or click a graph to select that hour': 'Tryk eller klik på en graf for at vælge den time',
  'Detailed graphs restricted to hourly available data': 'Detaljerede grafer viser kun timedata',
  'Wind & gusts': 'Vind & vindstød',
  'Water level': 'Vandstand',
  'Air & water temp': 'Luft- & vandtemperatur',
  '{0} m · period {1} s': '{0} m · periode {1} s',
  'air {0}°': 'luft {0}°',
  'water {0}°': 'vand {0}°',
  'wind safe {0}': 'vind sikker {0}',
  'wind danger {0}': 'vind fare {0}',
  'wind/gust danger {0}': 'vind/vindstød fare {0}',
  'gust danger {0}': 'vindstød fare {0}',
  'wave safe {0}': 'bølger sikker {0}',
  'danger {0}': 'fare {0}',
  'water min {0}°': 'vand min {0}°',
  'danger below {0}°': 'fare under {0}°',

  // ── WarningStripe (+ planner warning badge) ───────────────────────────────
  'Yellow': 'Gul',
  'Orange': 'Orange',
  'Red': 'Rød',
  'Yellow warnings': 'gule varsler',
  'Orange warnings': 'orange varsler',
  'Red warnings': 'røde varsler',
  'Yellow weather warnings': 'gule vejrvarsler',
  'Orange weather warnings': 'orange vejrvarsler',
  'Red weather warnings': 'røde vejrvarsler',
  '{0} warning · {1}': '{0} varsel · {1}',
  '{0} warning · {1} · +{2} more': '{0} varsel · {1} · +{2} mere',
  '{0} weather warning': '{0} vejrvarsel',
  '{0} weather warning and {1} more': '{0} vejrvarsel og {1} mere',
  '{0} for the {1}, {2}.': '{0} for {1}, {2}.',
  'Opens DMI warnings in a new tab for the full details.': "Åbner DMI's varsler i en ny fane med alle detaljer.",
  'until {0}': 'indtil {0}',
  'until {0} {1}': 'indtil {0} {1}',
  'your region': 'dit område',

  // ── LocationSwitcher ──────────────────────────────────────────────────────
  'Choose location': 'Vælg sted',
  'provisional': 'foreløbig',
  'Provisional — limits not yet locally calibrated': 'Foreløbig — grænserne er endnu ikke lokalt kalibreret',

  // ── TripProfilePanel ──────────────────────────────────────────────────────
  'Trip Profile': 'Turprofil',
  'About the modes': 'Om profilerne',
  'How cautious should FRANK be for you?': 'Hvor forsigtig skal FRANK være for dig?',
  'are presets — from the most cautious limits for beginners and easy trips to the loosest limits for experienced paddlers.':
    'er forudindstillinger — fra de mest forsigtige grænser til begyndere og lette ture til de løseste grænser for erfarne roere.',
  'is your own set: change anything in Your Limits below and it lands there.':
    'er dit eget sæt: ændr hvad som helst i Dine grænser nedenfor, og det lander der.',
  'Picking a mode updates the exact numbers in Your Limits — the manual explains every rule.':
    'Valg af en profil opdaterer de præcise tal i Dine grænser — manualen forklarer hver regel.',
  'Trip mode': 'Turprofil',

  // ── SafetyLimitsPanel ─────────────────────────────────────────────────────
  'Your Limits': 'Dine grænser',
  'How FRANK Decides': 'Sådan vurderer FRANK',
  'Your personal limits': 'Dine personlige grænser',
  'Changes apply immediately and switch you to Custom mode. Pick a preset in the Trip Profile at the top (Chill, Normal, Pro) to go back.':
    'Ændringer træder i kraft med det samme og skifter dig til Custom. Vælg en forudindstilling i turprofilen øverst (Chill, Normal, Pro) for at gå tilbage.',
  'Decrease {0}': 'Sænk {0}',
  'Increase {0}': 'Hæv {0}',
  'Max Wind': 'Maks vind',
  'Max wind limit enabled': 'Grænse for maks vind slået til',
  'm/s wind': 'm/s vind',
  'max wind': 'maks vind',
  '0 calm': '0 stille',
  'caution to {0}': 'pas på til {0}',
  '20+ gale': '20+ kuling',
  'Wind gust margin enabled': 'Vindstødsmargen slået til',
  'Gust margin': 'Vindstødsmargen',
  'gusts up to {0} m/s rate Caution': 'vindstød op til {0} m/s vurderes Pas på',
  'gust margin': 'vindstødsmargen',
  'Max Wave': 'Maks bølge',
  'Max wave limit enabled': 'Grænse for maks bølge slået til',
  'm waves': 'm bølger',
  'max wave': 'maks bølge',
  '0 flat': '0 fladt',
  '1.5+ rough': '1,5+ uroligt',
  'Wave caution margin enabled': 'Bølgemargen slået til',
  'Caution margin': 'Pas på-margen',
  'waves up to {0} m rate Caution': 'bølger op til {0} m vurderes Pas på',
  'wave caution margin': 'bølgemargen',
  'Min Water Temp': 'Min vandtemperatur',
  'Water temperature limit enabled': 'Grænse for vandtemperatur slået til',
  '°C water': '°C vand',
  'min water temperature': 'min vandtemperatur',
  '0 ice': '0 is',
  'safe from {0}°': 'sikker fra {0}°',
  '25 summer': '25 sommer',
  'Caution band': 'Pas på-bånd',
  '{0}–{1} °C asks for thermal wear': '{0}–{1} °C kræver termotøj',
  'water temperature caution band': 'pas på-bånd for vandtemperatur',
  'Safe / Comfortable': 'Sikkert / Behageligt',
  'Caution / Cold Water': 'Pas på / Koldt vand',
  'Danger / Cold Shock': 'Fare / Kuldechok',
  'Advanced — duration, water level, daylight & wind sectors': 'Avanceret — varighed, vandstand, dagslys & vindsektorer',
  'Min Duration': 'Min varighed',
  'Shortest usable launch window': 'Korteste brugbare rovindue',
  '1 hour': '1 time',
  '{0} hours': '{0} timer',
  'Preferred water level for launching': 'Foretrukken vandstand ved isætning',
  'Any Level': 'Alle vandstande',
  'High Water': 'Højvande',
  'Low Water': 'Lavvande',
  'Rising': 'Stigende',
  'Daylight Only': 'Kun dagslys',
  'Flag night hours as Take care': 'Markér nattetimer som Pas på',
  'Local wind sectors': 'Lokale vindsektorer',
  'Stricter caps for {0}, plus wind-against-water-level chop': 'Strammere lofter for {0}, plus krap sø ved vind mod vandstand',
  'Apply local wind-sector caps': 'Anvend lokale vindsektorlofter',
  'Wind from these directions is rougher here than its speed alone suggests, so FRANK caps them tighter.':
    'Vind fra disse retninger er mere barsk her, end styrken alene antyder, så FRANK sætter strammere lofter.',
  'from {0}': 'fra {0}',
  'Safe cap': 'Sikkert loft',
  '{0} safe cap': '{0} sikkert loft',
  'Danger cap': 'Fareloft',
  '{0} danger cap': '{0} fareloft',
  'Directions are fixed to the local geography. Only the wind speeds are yours.':
    'Retningerne er fastlagt efter den lokale geografi. Kun vindstyrkerne er dine.',
  'onshore': 'pålandsvind',
  'offshore': 'fralandsvind',
  'cross-shore': 'sidevind',

  // Curated wind-sector labels & descriptions (config/locations.json)
  'Easterly': 'Østlig',
  'Westerly': 'Vestlig',
  'Onshore wind into Horsens Fjord — longest fetch, biggest chop':
    'Pålandsvind ind i Horsens Fjord — længste frie stræk, mest krap sø',
  'Offshore wind (fralandsvind) away from the inner fjord — capped lower for drift risk despite flatter water':
    'Fralandsvind væk fra den indre fjord — lavere loft pga. afdriftsrisiko trods fladere vand',
  'Onshore wind up the fjord from the open east mouth — longest fetch, biggest chop':
    'Pålandsvind op ad fjorden fra den åbne østlige munding — længste frie stræk, mest krap sø',
  'Offshore wind (fralandsvind) from the sheltered west head — capped lower for drift risk despite flatter water':
    'Fralandsvind fra den læfyldte vestlige ende — lavere loft pga. afdriftsrisiko trods fladere vand',
  'Onshore wind up the fjord from Lillebælt — longest fetch, biggest chop':
    'Pålandsvind op ad fjorden fra Lillebælt — længste frie stræk, mest krap sø',
  'Offshore wind (fralandsvind) from the west head — capped lower for drift risk':
    'Fralandsvind fra den vestlige ende — lavere loft pga. afdriftsrisiko',
  'Onshore wind off the open bay — long Kattegat fetch onto the city shore':
    'Pålandsvind fra den åbne bugt — langt frit stræk fra Kattegat ind mod bykysten',
  'Offshore wind (fralandsvind) from the city shore — capped lower for drift risk':
    'Fralandsvind fra bykysten — lavere loft pga. afdriftsrisiko',

  // ── SafetyManualModal ─────────────────────────────────────────────────────
  'HOW FRANK DECIDES': 'SÅDAN VURDERER FRANK',
  '1. Wave Height': '1. Bølgehøjde',
  'Significant wave height is checked against your': 'Signifikant bølgehøjde tjekkes mod din',
  'safe limit and caution margin:': 'sikre grænse og pas på-margen:',
  'Good to go:': 'Klar til at ro:',
  'Wave height below your Max Wave safe limit.': 'Bølgehøjde under din sikre maks bølge-grænse.',
  'Take care:': 'Pas på:',
  'At or above the safe limit, but below (Max Wave + Wave Caution Margin).':
    'På eller over den sikre grænse, men under (maks bølge + bølgemargen).',
  'Rough:': 'Bliv i land:',
  'At or above the danger threshold (Max Wave + Wave Caution Margin). Waves big enough to tip you — best avoided.':
    'På eller over faretærsklen (maks bølge + bølgemargen). Bølger store nok til at vælte dig — bedst at undgå.',
  'If the caution margin toggle is off, the caution band disappears: waves rate Safe all the way up to the danger threshold.':
    'Er pas på-margenen slået fra, forsvinder pas på-båndet: bølger vurderes sikre helt op til faretærsklen.',
  '2. Wind Speed & Gusts': '2. Vindstyrke & vindstød',
  'Average wind speed and peak gusts are checked independently against one shared ceiling: the':
    'Middelvind og maksimale vindstød tjekkes hver for sig mod ét fælles loft:',
  'Wind Gust Margin': 'vindstødsmargenen',
  'sets how far above your Max Wind Safe limit either may go before rating Danger (there is no separate danger-wind control — the threshold is Max Wind Safe + Gust Margin):':
    'bestemmer, hvor langt over din sikre maks vind-grænse de må gå, før vurderingen bliver Fare (der er ingen separat fare-vind-kontrol — tærsklen er sikker maks vind + vindstødsmargen):',
  'Both wind and gusts below Max Wind Safe.': 'Både vind og vindstød under sikker maks vind.',
  'Wind or gusts between Max Wind Safe and Max Wind Safe + Gust Margin.':
    'Vind eller vindstød mellem sikker maks vind og sikker maks vind + vindstødsmargen.',
  'Wind or gusts at or above Max Wind Safe + Gust Margin.':
    'Vind eller vindstød på eller over sikker maks vind + vindstødsmargen.',
  'Example: Max Wind Safe = 5 m/s, Gust Margin = 3 m/s means the gust ceiling is 8 m/s. A gust of 7.2 m/s exceeds the 5 m/s safe limit and rates Caution; 8.4 m/s rates Danger.':
    'Eksempel: sikker maks vind = 5 m/s og vindstødsmargen = 3 m/s giver et vindstødsloft på 8 m/s. Et vindstød på 7,2 m/s overskrider den sikre grænse på 5 m/s og vurderes Pas på; 8,4 m/s vurderes Fare.',
  '3. Wind-against-Water-Level Clashing': '3. Vind mod vandstand',
  'Active only when': 'Kun aktiv når',
  'is enabled. The app compares the current water level with the next forecast hour to detect rising or falling water. If sustained wind opposes that water movement, short steep chop is more likely:':
    'er slået til. Appen sammenligner den aktuelle vandstand med næste prognosetime for at se, om vandet stiger eller falder. Hvis vedvarende vind går imod vandets bevægelse, er kort, krap sø mere sandsynlig:',
  '{0} wind': '{0} vind',
  'can oppose rising water.': 'kan gå imod stigende vand.',
  'can oppose falling water.': 'kan gå imod faldende vand.',
  'If a clash occurs and wind speed > 4.0 m/s, the hour is automatically marked':
    'Opstår en konflikt, og vindstyrken er > 4,0 m/s, markeres timen automatisk',
  'Caution': 'Pas på',
  '4. Local Wind Sectors': '4. Lokale vindsektorer',
  'is enabled. Applies separate, stricter absolute limits for the wind sectors configured for {0}:':
    'er slået til. Anvender separate, strammere absolutte grænser for vindsektorerne for {0}:',
  'Safe cap: {0} m/s, danger cap: {1} m/s.': 'Sikkert loft: {0} m/s, fareloft: {1} m/s.',
  'These limits use': 'Disse grænser bruger',
  'average wind speed only': 'kun middelvind',
  '(not gusts), as standing-wave hazards here are driven by sustained wind blowing across a long open stretch of water (its "fetch").':
    '(ikke vindstød), da farlige stående bølger her skabes af vedvarende vind hen over et langt frit stræk af vand (dets "fetch").',
  'Directions are fixed to the local geography; only the speed caps are yours to adjust.':
    'Retningerne er fastlagt efter den lokale geografi; kun vindlofterne kan du justere.',
  '5. Water Level': '5. Vandstand',
  'Water level comes from a storm-surge forecast model, not an astronomical tide table. The value shown is the forecast water level relative to mean sea level at the nearest model grid point, including wind setup and pressure effects.':
    'Vandstanden kommer fra en stormflodsmodel, ikke en astronomisk tidevandstabel. Den viste værdi er den forudsagte vandstand i forhold til middelvandstand ved nærmeste modelpunkt, inklusive vindstuvning og trykeffekter.',
  'High Water Filter:': 'Højvandsfilter:',
  'Water level ≥ +0.1 m. Useful for shallow areas.': 'Vandstand ≥ +0,1 m. Nyttigt i lavvandede områder.',
  'Low Water Filter:': 'Lavvandsfilter:',
  'Water level ≤ -0.1 m.': 'Vandstand ≤ -0,1 m.',
  'Rising Only:': 'Kun stigende:',
  'Water level rises through the whole launch window.': 'Vandstanden stiger gennem hele rovinduet.',
  '6. Weather Condition (Rain, Snow, Sleet, Fog, Thunder)': '6. Vejrforhold (regn, sne, slud, tåge, torden)',
  "The weather condition comes straight from the forecast's own symbol (MET Norway's symbol_code) — FRANK does not compute its own rain or lightning judgement. Each condition maps to a severity:":
    'Vejrforholdet kommer direkte fra prognosens eget symbol (MET Norways symbol_code) — FRANK beregner ikke sin egen regn- eller lynvurdering. Hvert forhold svarer til en alvorlighed:',
  'clear, cloudy, light drizzle, and light rain — no weather warning.': 'klart, skyet, let støvregn og let regn — ingen vejradvarsel.',
  'moderate rain, light snow, sleet, fog, and rain showers — worth keeping an eye on.':
    'moderat regn, let sne, slud, tåge og regnbyger — værd at holde øje med.',
  'heavy rain, heavier snow or sleet, snow showers, and thunderstorms — probably one to skip.':
    'kraftig regn, kraftigere sne eller slud, snebyger og tordenvejr — nok en dag at springe over.',
  'There is no configurable rain limit or lightning slider: the forecast decides the condition, and the reason shows its plain description (for example "Heavy rain" or "Thunderstorm").':
    'Der er ingen indstillelig regngrænse eller lyn-skyder: prognosen afgør forholdet, og begrundelsen viser dets almindelige beskrivelse (for eksempel "Kraftig regn" eller "Tordenvejr").',
  '7. How Rules Combine': '7. Sådan kombineres reglerne',
  'Every enabled rule is evaluated for every hour, and the overall rating is the':
    'Hver aktiveret regel vurderes for hver time, og den samlede vurdering er det',
  'worst result': 'værste resultat',
  'among them. A rule can only raise the severity (Safe → Caution → Danger) — no rule can lower a rating another rule has already set:':
    'blandt dem. En regel kan kun hæve alvorligheden (Sikker → Pas på → Fare) — ingen regel kan sænke en vurdering, en anden regel allerede har sat:',
  'One Danger rule (for example a thunderstorm or heavy-rain forecast) makes the whole hour Danger, regardless of how calm everything else looks.':
    'Én fareregel (for eksempel varslet tordenvejr eller kraftig regn) gør hele timen til Fare, uanset hvor roligt alt andet ser ud.',
  'Caution-only rules (wind-against-water clash > 4 m/s, nighttime) never raise an hour above Caution on their own.':
    'Regler, der højst giver Pas på (vind mod vandstand > 4 m/s, nat), hæver aldrig en time over Pas på alene.',
  'Every triggered rule is listed in the assessment, so you always see all reasons — not just the worst one.':
    'Hver udløst regel vises i vurderingen, så du altid ser alle begrundelser — ikke kun den værste.',
  '8. Water Temperature': '8. Vandtemperatur',
  "Cold shock and hypothermia risk, checked against your configured limits. The defaults are conservative starting points — set them to your own club's rules, your gear, and the season:":
    'Risiko for kuldechok og hypotermi, tjekket mod dine indstillede grænser. Standardværdierne er forsigtige udgangspunkter — sæt dem efter din klubs regler, dit udstyr og årstiden:',
  'Safe for general paddling clothing.': 'Sikkert med almindeligt rotøj.',
  'Caution. Thermal layers or wetsuit strongly recommended.': 'Pas på. Termolag eller våddragt anbefales kraftigt.',
  'Danger. Drysuit or heavy wetsuit required.': 'Fare. Tørdragt eller tyk våddragt påkrævet.',
  '9. Daylight Rule': '9. Dagslysregel',
  'Many clubs prohibit paddling between sunset and sunrise without navigation lights and permission, so when this rule is on, hourly forecasts outside daylight are marked Caution (turn it off if night paddling is fine for you). Longer-range outlook periods are handled per launch window instead: windows with no daylight at all are dropped, and windows that span night hours show only their daylight part in the list.':
    'Mange klubber forbyder roning mellem solnedgang og solopgang uden lanterner og tilladelse, så når denne regel er slået til, markeres timeprognoser uden for dagslys som Pas på (slå den fra, hvis natroning er i orden for dig). Langtidsudsigtens perioder håndteres i stedet pr. rovindue: vinduer helt uden dagslys udelades, og vinduer, der spænder over nattetimer, viser kun deres dagslysdel i listen.',
  '10. Launch Windows': '10. Rovinduer',
  'A launch window is an unbroken run of Good-to-go hours — an hour rated Take care or Rough breaks the run:':
    'Et rovindue er en ubrudt række af Klar til at ro-timer — en time vurderet Pas på eller Bliv i land bryder rækken:',
  'Minimum duration:': 'Minimumsvarighed:',
  'runs shorter than your Min Duration setting are not shown.': 'forløb kortere end din min varighed vises ikke.',
  'Day boundaries:': 'Døgngrænser:',
  'hourly windows split at local midnight, so each belongs to one calendar day; longer-range outlook windows can run past it (the end time then shows its day).':
    'timevinduer deles ved lokal midnat, så hvert hører til én kalenderdag; langtidsudsigtens vinduer kan løbe forbi den (sluttiden viser da sin dag).',
  'Longer range:': 'Længere sigt:',
  'beyond the hourly forecast, coarser outlook blocks (6 hours, occasionally 12) form windows marked "lower confidence" — treat them as hints, not commitments.':
    'ud over timeprognosen danner grovere udsigtsblokke (6 timer, af og til 12) vinduer markeret "lavere sikkerhed" — tag dem som fingerpeg, ikke løfter.',
  'Close': 'Luk',
};
