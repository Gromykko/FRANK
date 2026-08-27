// Danish dictionary. Keys are the FULL English source strings (readable call
// sites; a missing entry soft-fails to English). {0}/{1}… are argument slots.
// Organized by the component/module the strings live in.
export const da: Record<string, string> = {
  // ── Shared verdict & rating words ──────────────────────────────────────────
  'Good to go': 'Klar til at ro',
  'Take care': 'Pas på',
  'Rough': 'Barskt',
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
  // Matches the toggle that turns it on ("Kun vejr - sla alle dine graenser fra"),
  // so the device names the same state the control does.
  'Weather mode': 'Kun vejr',
  'Limits are off — raw forecast only': 'Grænserne er slået fra — kun rå prognose',
  'Have fun out there': 'God tur derude',
  'Keep an eye out': 'Hold øje undervejs',
  // Now rendered directly under the big "BLIV I LAND" verdict rather than only
  // to screen readers, so it has to back the verdict up instead of hedging it —
  // "måske" (maybe) undercut the one call the app is firmest about.
  'Save it for another day': 'Gem den til en anden dag',
  'Your personal limits are off. Use the raw forecast values and local judgement before launching.':
    'Dine personlige grænser er slået fra. Brug de rå prognosetal og lokal dømmekraft, før du tager på vandet.',
  'Off duty. You are the captain now': 'Ikke på vagt. Du er kaptajnen nu',
  'Switch to dark theme': 'Skift til mørkt tema',
  'Switch to light theme': 'Skift til lyst tema',
  'built {0}': 'bygget {0}',
  'The forecast is briefly out of date while FRANK updates behind the scenes. Please check back in a few minutes.':
    'Prognosen er kortvarigt forældet, mens FRANK opdaterer i baggrunden. Kig tilbage om et par minutter.',
  'The forecast could not be refreshed. You are seeing data from {0} — {1} old, so treat it with extra caution. FRANK retries by itself roughly every 10 minutes.':
    'Prognosen kunne ikke opdateres. Du ser data fra {0} — {1} gamle, så brug dem med ekstra forsigtighed. FRANK prøver selv igen cirka hvert 10. minut.',
  // Offline AND old: the age warning still fires (a paddler on the water needs
  // it), but nothing is "failing" — there is no connection to try over.
  'You have been offline for a while, so this forecast is from {0} — {1} old. Treat it with extra caution; it will update by itself once you are back online.':
    'Du har været offline et stykke tid, så denne prognose er fra {0} — {1} gammel. Brug den med ekstra forsigtighed; den opdateres af sig selv, når du er online igen.',
  'Hourly forecast timeline': 'Timeprognosens tidslinje',
  // Explains the striped, time-span columns where the matrix stops being hourly.
  // ── Meteogram outlook legend ──────────────────────────────────────────────
  'Columns like 02–08 show a 6-hour block.': 'Kolonner som 02–08 viser en 6-timers blok.',
  'Waves and water temperature: the highest waves and coldest water.':
    'Bølger og vandtemperatur: højeste bølger og koldeste vand.',
  'Wind and air temperature: MET’s reading for the block.':
    'Vind og lufttemperatur: METs måling for blokken.',
  'Water level: high water': 'Niveau: højvande',
  'low water': 'lavvande',
  'both': 'begge',
  'or near mean': 'eller omkring middel',
  'Water level: high water, low water, both, or near mean.':
    'Niveau: højvande, lavvande, begge eller omkring middel.',
  'Tap a block for its numbers.': 'Tryk på en blok for at se tallene.',
  'Detailed Graphs': 'Detaljerede grafer',
  'Wind, waves, water level, and temperature': 'Vind, bølger, niveau og temperatur',
  'Loading charts...': 'Indlæser grafer...',
  'Weather data by MET Norway': 'Vejrdata fra MET Norway',
  ', waves & water by DMI ({0}) for {1}.': ', bølger & vandstand fra DMI ({0}) for {1}.',
  'Warnings by': 'Varsler fra',
  'Time delays between this website and the www.meteoalarm.org website are possible. For the most up-to-date awareness information as published by the participating National Meteorological and Hydrological Services, please refer to www.meteoalarm.org.':
    'Der kan forekomme tidsforsinkelser mellem denne hjemmeside og hjemmesiden www.meteoalarm.org. For de senest opdaterede varslingsoplysninger, som de deltagende nationale meteorologiske og hydrologiske tjenester har offentliggjort, henvises der til www.meteoalarm.org.',
  'Forecast built {0}. Worker checked {1}.': 'Prognose bygget {0}. Server tjekket {1}.',
  'Data and version': 'Data og version',
  'Technical data note': 'Teknisk datanote',
  'FRANK has no user accounts, sets no cookies, does not track your GPS, and includes no advertising or analytics trackers. Your chosen location, your limits, and offline forecasts are stored strictly in this browser.':
    'FRANK har ingen brugerkonti, sætter ingen cookies, sporer ikke din GPS og indeholder ingen reklamer eller analyseværktøjer. Dine valgte steder, sikkerhedsgrænser og offline-prognoser gemmes udelukkende lokalt i denne browser.',
  'Served via Cloudflare and GitHub Pages.': 'Serveres via Cloudflare og GitHub Pages.',
  'Privacy policies:': 'Privatlivspolitikker:',
  'logs': 'logs',
  'Delete saved choices and forecasts': 'Slet gemte valg og prognoser',
  'Tap again to delete and reload': 'Tryk igen for at slette og genindlæse',
  'Try deleting local data again': 'Prøv at slette lokale data igen',
  'This removes FRANK’s saved settings and offline forecast from this browser, then reloads immediately with the defaults.':
    'Dette fjerner FRANKs gemte indstillinger og offlineprognose fra denne browser og genindlæser derefter straks med standardindstillingerne.',
  'FRANK could not access browser storage. Try again, or use your browser’s site-data controls.':
    'FRANK kunne ikke få adgang til browserlageret. Prøv igen, eller brug browserens funktion til at rydde webstedsdata.',

  // useForecast error strings (shown via t(error))
  'No forecast data is available yet.': 'Der er ingen prognosedata endnu.',
  'Could not reach the forecast service — showing the last saved forecast.':
    'Kunne ikke nå prognosetjenesten — viser den senest gemte prognose.',
  'Could not refresh forecast data. Showing the latest cached forecast if available.':
    'Kunne ikke opdatere prognosen. Viser den senest gemte prognose, hvis den findes.',
  'The latest preparation check did not finish. FRANK will keep trying automatically.':
    'Det seneste klargøringstjek blev ikke færdigt. FRANK bliver ved med at prøve automatisk.',

  // ── ForecastInitializingScreen ────────────────────────────────────────────
  'Forecast data': 'Prognosedata',
  'Forecasts are being prepared': 'Vejrudsigterne gøres klar',
  'The forecast for {0} is being prepared': 'Prognosen for {0} gøres klar',
  'Opening the forecast for {0}': 'Åbner prognosen for {0}',
  'Checking forecast availability…': 'Tjekker tilgængelige prognoser…',
  'Preparation in progress': 'Klargøring i gang',
  'There is no complete forecast to show yet. Safety verdicts and launch windows stay hidden until forecast data is ready.':
    'Der er endnu ingen komplet prognose at vise. Sikkerhedsvurderinger og rovinduer forbliver skjult, indtil prognosedata er klar.',
  '{0} of {1} areas already have a complete forecast. You can open one now while FRANK prepares the others.':
    '{0} af {1} områder har allerede en komplet prognose. Du kan åbne en nu, mens FRANK klargør de andre.',
  'A complete forecast is available. FRANK is opening it now.':
    'En komplet prognose er klar. FRANK åbner den nu.',
  'The selected forecast is not ready yet. Safety verdicts and launch windows stay hidden until complete data is available.':
    'Den valgte prognose er ikke klar endnu. Sikkerhedsvurderinger og rovinduer forbliver skjult, indtil der er komplette data.',
  'FRANK checks again automatically. This screen updates as forecasts become available.':
    'FRANK tjekker automatisk igen. Skærmen opdateres, efterhånden som prognoserne bliver klar.',
  "You're offline. FRANK will continue as soon as this device is back online.":
    'Du er offline. FRANK fortsætter, så snart enheden er online igen.',
  'Check manually': 'Tjek manuelt',
  'Check manually ({0}s)': 'Tjek manuelt ({0}s)',
  'Check now': 'Tjek nu',
  'Check now ({0}s)': 'Tjek nu ({0}s)',
  'Check again': 'Tjek igen',
  'Check again ({0}s)': 'Tjek igen ({0}s)',
  'Forecasts ready now': 'Prognoser klar nu',
  'ready': 'klar',
  'preparing': 'klargøres',
  'FRANK could not save that location in this browser. Try again or check the browser’s site-data settings.':
    'FRANK kunne ikke gemme stedet i denne browser. Prøv igen, eller kontrollér browserens indstillinger for webstedsdata.',

  // ── StatusBar ──────────────────────────────────────────────────────────────
  '{0}. {1}. FRANK says: {2}.': '{0}. {1}. FRANK siger: {2}.',
  'Refresh forecast': 'Opdater prognosen',
  'Switch to English': 'Skift til engelsk',
  'Switch to Danish': 'Skift til dansk',
  'Detailed graph summary': 'Oversigt over detaljerede grafer',
  'Detailed weather graphs showing wind, gusts, waves, water level, and temperature. All values are also available in text in the hourly forecast timeline table above.':
    'Detaljerede vejrgrafer for vind, vindstød, bølger, vandstand og temperatur. Alle værdier findes også som tekst i timeoversigten ovenfor.',

  // ── FRANK's dot-matrix phrases ─────────────────────────────────────────────
  'Good weather, go ahead!': 'Godt vejr — af sted med dig!',
  'The {0} looks fint. Off you go': '{0} ser fin ud. Af sted',
  'Smooth as smørrebrød out there': 'Glat som smørrebrød derude',
  'Even the herring approve today': 'Selv sildene godkender i dag',
  'Grab the paddle before the weather changes its mind': 'Grib pagajen, før vejret ombestemmer sig',
  'No bad weather, only bad clothing': 'Der findes ikke dårligt vejr, kun dårligt tøj',
  'Doable — but pick your moment': 'Til at gå til — men vælg dit tidspunkt',
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
  'Showing your older saved forecast from {0}': 'Viser din ældre gemte prognose fra {0}',
  'wind': 'vind',
  'waves': 'bølger',
  'Refreshing…': 'Opdaterer…',
  'Preparing update…': 'Klargør opdatering…',
  'Saved forecast · {0}': 'Gemt prognose · {0}',
  'Showing saved forecast · {0} old': 'Viser gemt prognose · {0} gammel',
  'Needs a new check': 'Skal tjekkes igen',
  'Checking…': 'Tjekker…',
  'Couldn’t refresh': 'Kunne ikke opdatere',
  'Retrying automatically': 'Prøver igen automatisk',
  'Water-level forecast update delayed': 'Opdateringen af vandstandsprognosen er forsinket',
  'Wave forecast update delayed': 'Opdateringen af bølgeprognosen er forsinket',
  'Marine forecast update delayed': 'Opdateringen af havprognosen er forsinket',
  'Wind forecast update delayed': 'Opdateringen af vindprognosen er forsinket',
  'Wind and water-level forecast updates delayed': 'Opdateringen af vind- og vandstandsprognoserne er forsinket',
  'Wind and wave forecast updates delayed': 'Opdateringen af vind- og bølgeprognoserne er forsinket',
  'Wind and marine forecast updates delayed': 'Opdateringen af vind- og havprognoserne er forsinket',
  'Showing your saved forecast from {0} · {1}': 'Viser din gemte prognose fra {0} · {1}',
  '{0} min': '{0} min',
  '{0} h': '{0} t',
  '{0} d': '{0} d',
  "You're offline, so FRANK is showing your last saved forecast from {0}. It will refresh on its own once you're back online.":
    'Du er offline, så FRANK viser din senest gemte prognose fra {0}. Den opdateres af sig selv, når du er online igen.',
  'FRANK is updating now; meanwhile it is showing the saved forecast from {0}, which is {1} old.':
    'FRANK opdaterer nu; imens vises den gemte prognose fra {0}, som er {1} gammel.',
  'FRANK reached the forecast service, which is preparing a complete update. It will retry automatically; meanwhile you are seeing the saved forecast from {0}.':
    'FRANK har kontakt med prognosetjenesten, som klargør en komplet opdatering. FRANK prøver igen automatisk; imens ser du den gemte prognose fra {0}.',
  'The saved forecast from {0} needs a new check.':
    'Den gemte prognose fra {0} skal tjekkes igen.',
  'The forecast could not be refreshed; FRANK is retrying automatically. You are seeing the last good forecast from {0}.':
    'Prognosen kunne ikke opdateres; FRANK prøver igen automatisk. Du ser den seneste gode prognose fra {0}.',
  'Forecast from {0}. {1}.': 'Prognose fra {0}. {1}.',
  'Checking for a newer forecast': 'Tjekker efter en nyere prognose',
  'Forecast from {0}': 'Prognose fra {0}',
  ' Last issue: {0}': ' Seneste fejl: {0}',
  'Advisory only — FRANK does not replace official warnings, club rules, or your own look at the water. You are responsible for the decision to launch.':
    'Kun vejledende — FRANK erstatter ikke officielle varsler, klubbens regler eller dit eget blik på vandet. Du har selv ansvaret for beslutningen om at tage ud.',
  'The forecast came back with no hours in it.': 'Prognosen kom tilbage uden timer i.',
  'Charts are unavailable right now. The forecast above is unaffected.':
    'Graferne er ikke tilgængelige lige nu. Prognosen ovenfor er upåvirket.',
  // Missing-reading wording — see analyzeSafetyConditions.
  'No reading for {0} this hour, so FRANK cannot clear it. Unknown is not the same as safe — check another source before you launch.':
    'FRANK har ingen måling af {0} denne time og kan derfor ikke frikende den. Ukendt er ikke det samme som sikkert — tjek en anden kilde, før du tager ud.',
  'wind speed': 'vindhastighed',
  'wind gusts': 'vindstød',
  'wind direction': 'vindretning',
  'wave height': 'bølgehøjde',
  'water temperature': 'vandtemperatur',
  'Unknown': 'Ukendt',
  'sea state unknown': 'ukendt søtilstand',
  'danger from {0}': 'fare fra {0}',
  'Forecast days': 'Prognosedage',

  // ── Safety reasons (analyzeSafetyConditions.ts) ───────────────────────────
  'Wind speed: {0} m/s ({1}). Exceeds your danger limit of {2} m/s.':
    'Vindstyrke: {0} m/s ({1}). Over din faregrænse på {2} m/s.',
  'Wind speed: {0} m/s ({1}). Above your Take care threshold of {2} m/s.':
    'Vindstyrke: {0} m/s ({1}). Over din Pas på-grænse på {2} m/s.',
  'Wind gusts: {0} m/s. Above your gust danger threshold of {1} m/s.':
    'Vindstød: {0} m/s. Over din faregrænse for vindstød på {1} m/s.',
  'Wind gusts: {0} m/s. Above your Take care threshold of {1} m/s.':
    'Vindstød: {0} m/s. Over din Pas på-grænse på {1} m/s.',
  '{0} wind ({1}°) is over your {2} m/s danger threshold for this direction.':
    '{0} vind ({1}°) er over din faregrænse på {2} m/s for denne retning.',
  '{0} wind ({1}°) is over your {2} m/s Take care threshold for this direction.':
    '{0} vind ({1}°) er over din Pas på-grænse på {2} m/s for denne retning.',
  'Wind-against-water-level conflict: wind opposes {0} water level. Expect steeper chop.':
    'Vind mod vandstand: vinden går imod {0} vandstand. Forvent mere krap sø.',
  "Water temperature: {0}°C — colder than your danger limit of {1}°C. You'd really want a drysuit or heavy thermals for this.":
    'Vandtemperatur: {0}°C — koldere end din faregrænse på {1}°C. Her vil du virkelig ønske dig en tørdragt eller tykt termotøj.',
  'Water temperature: {0}°C — under your safe limit of {1}°C. Worth layering up.':
    'Vandtemperatur: {0}°C — under din sikre grænse på {1}°C. Tag et ekstra lag på.',
  'Wave height: {0} m ({1}). Exceeds your danger limit of {2} m.':
    'Bølgehøjde: {0} m ({1}). Over din faregrænse på {2} m.',
  'Wave height: {0} m ({1}). Above your Take care threshold of {2} m.':
    'Bølgehøjde: {0} m ({1}). Over din Pas på-grænse på {2} m.',
  // "At your limit" variants — used when the reading rounds exactly onto the
  // limit, so it doesn't read as a confusing "0,20 overstiger 0,2".
  'Wind speed: {0} m/s ({1}). At your danger limit of {2} m/s.':
    'Vindstyrke: {0} m/s ({1}). På din faregrænse på {2} m/s.',
  'Wind speed: {0} m/s ({1}). At your Take care threshold of {2} m/s.':
    'Vindstyrke: {0} m/s ({1}). På din Pas på-grænse på {2} m/s.',
  'Wind gusts: {0} m/s. At your gust danger threshold of {1} m/s.':
    'Vindstød: {0} m/s. På din faregrænse for vindstød på {1} m/s.',
  'Wind gusts: {0} m/s. At your Take care threshold of {1} m/s.':
    'Vindstød: {0} m/s. På din Pas på-grænse på {1} m/s.',
  '{0} wind ({1}°) is at your {2} m/s danger threshold for this direction.':
    '{0} vind ({1}°) er på din faregrænse på {2} m/s for denne retning.',
  '{0} wind ({1}°) is at your {2} m/s Take care threshold for this direction.':
    '{0} vind ({1}°) er på din Pas på-grænse på {2} m/s for denne retning.',
  'Wave height: {0} m ({1}). At your danger limit of {2} m.':
    'Bølgehøjde: {0} m ({1}). På din faregrænse på {2} m.',
  'Wave height: {0} m ({1}). At your Take care threshold of {2} m.':
    'Bølgehøjde: {0} m ({1}). På din Pas på-grænse på {2} m.',
  '{0} — rough out there, probably one to skip.': '{0} — barskt derude, nok en dag at springe over.',
  '{0} — worth keeping an eye on.': '{0} — værd at holde øje med.',
  'Nighttime: outside sunrise-to-sunset paddling hours.': 'Nat: uden for rotimerne mellem solopgang og solnedgang.',
  'Daylight: part of this outlook period is outside sunrise-to-sunset paddling hours.':
    'Dagslys: en del af denne udsigtsperiode ligger uden for rotimerne mellem solopgang og solnedgang.',
  'Daylight: this outlook period has no complete hour within sunrise-to-sunset paddling hours.':
    'Dagslys: denne udsigtsperiode har ingen hel time mellem solopgang og solnedgang.',
  'Daylight: sunrise or sunset is unavailable for this outlook period, so FRANK cannot clear the whole period.':
    'Dagslys: solopgang eller solnedgang mangler for denne udsigtsperiode, så FRANK kan ikke frikende hele perioden.',
  "Everything's within your limits — {0}, {1}, {2}.": 'Alt er inden for dine grænser — {0}, {1}, {2}.',
  'The outlook is within your limits — {0}, {1}, {2}.': 'Udsigten ligger inden for dine grænser — {0}, {1}, {2}.',
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
  'Violent Storm': 'Stærk storm',
  'Hurricane': 'Orkan',

  // WMO sea-wave terms used as supplemental labels for numeric wave height
  'Calm sea': 'Stille sø',
  'Smooth sea': 'Glat sø',
  'Slight sea': 'Let sø',
  'Moderate sea': 'Moderat sø',
  'Rough sea': 'Grov sø',
  'Very rough sea': 'Meget grov sø',
  'High sea': 'Høj sø',
  'Very high sea': 'Meget høj sø',
  'Phenomenal sea': 'Ekstrem sø',

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

  // Compact weather categories for the phone-sized conditions ledger. The
  // full forecast description remains in the assessment below it.
  'Clear': 'Klart',
  'Mostly clear': 'Mest klart',
  'Rime fog': 'Rimtåge',
  'Drizzle': 'Støvregn',
  'Heavy drizzle': 'Tæt støvregn',
  'Icy drizzle': 'Isslag',
  'Rain': 'Regn',
  'Icy rain': 'Isslag',
  'Heavy icy rain': 'Kraftigt isslag',
  'Light snow': 'Let sne',
  'Snow': 'Sne',
  'Heavy snow': 'Kraftig sne',
  'Light showers': 'Lette byger',
  'Rain showers': 'Regnbyger',
  'Heavy showers': 'Kraftige byger',
  'Snow showers': 'Snebyger',
  'Thunder risk': 'Tordenrisiko',
  'Thunder/hail': 'Torden/hagl',

  // ── ConditionsSnapshot ────────────────────────────────────────────────────
  'Current conditions': 'Aktuelle forhold',
  'Air': 'Luft',
  'Wind': 'Vind',
  // Standalone label for the timeline cell's screen-reader readings (the
  // lowercase 'gusts {0}' below is the inline snapshot form).
  'Gusts': 'Vindstød',
  'Waves': 'Bølger',
  'Water': 'Vand',
  'Level': 'Niveau',
  'Direction': 'Retning',
  'Daylight': 'Dagslys',
  // Screen-reader-only labels for the sunrise/sunset cell, whose icons carry
  // no accessible name (see ConditionsSnapshot).
  // A DMI warning that has not started yet: say when the weather is expected
  // rather than showing only an expiry, which read as "already in force".
  // ('from {0}' is already defined further down, shared with the limits panel.)
  '{0} until {1}': '{0} til {1}',
  'Sunrise': 'Solopgang',
  'Sunset': 'Solnedgang',
  'gusts {0}': 'vindstød {0}',
  'gust {0}': 'stød {0}',
  '{0} to {1} cm': '{0} til {1} cm',
  'Wind from {0}. The arrow points downwind (where the wind is heading).':
    'Vind fra {0}. Pilen peger med vinden (derhen hvor vinden blæser).',
  'Long range outlook · more uncertain forecast': 'Langtidsudsigt · mere usikker prognose',
  'Overall rating: {0}.': 'Samlet vurdering: {0}.',
  'Conditions for {0}:': 'Forhold for {0}:',

  // ── TimelineBar ───────────────────────────────────────────────────────────
  'Today': 'I dag',
  'Wind direction, speed, and gusts (m/s)': 'Vindretning, -styrke og vindstød (m/s)',
  'Wave Height (m)': 'Bølgehøjde (m)',
  'Water level (cm)': 'Niveau (cm)',
  'Air temperature (°C)': 'Lufttemperatur (°C)',
  'Water temperature (°C)': 'Vandtemperatur (°C)',
  'Forecast hours': 'Prognosetimer',
  '(Night)': '(Nat)',
  '(Longer range, more uncertain forecast)': '(Længere sigt, mere usikker prognose)',

  // ── PaddlePlanner ─────────────────────────────────────────────────────────
  'Available Launch Windows': 'Ledige rovinduer',
  'Launch window view': 'Visning af rovinduer',
  'List': 'Liste',
  'Calendar': 'Kalender',
  'There are safe hours, but never {0} in a row. Lower the minimum duration in Advanced settings, or try another trip mode.':
    'Der er sikre timer, men aldrig {0} i træk. Sænk minimumsvarigheden under Avanceret, eller prøv en anden turprofil.',
  'There are safe hours, but never {0} in a row at your preferred water level. Lower the minimum duration or clear the water-level preference in Advanced settings.':
    'Der er sikre timer, men aldrig {0} i træk ved din foretrukne vandstand. Sænk minimumsvarigheden eller ryd vandstandspræferencen under Avanceret.',
  'No good windows in the forecast yet — conditions stay above your limits for now. Check back as it updates.':
    'Ingen gode vinduer i prognosen endnu — forholdene ligger over dine grænser for nu. Kig tilbage, når den opdateres.',
  'Your personal limits are switched off, so there is nothing to measure the forecast against and no window can be recommended. Turn a limit back on to see suggested windows.':
    'Dine personlige grænser er slået fra, så der er intet at måle prognosen op imod, og intet vindue kan anbefales. Slå en grænse til igen for at se foreslåede vinduer.',
  'Nothing you are still checking flagged this — {0}, {1}, {2}. Not checked: {3}.':
    'Intet af det, du stadig tjekker, gav udslag — {0}, {1}, {2}. Ikke tjekket: {3}.',
  'Nothing you are still checking flagged the outlook — {0}, {1}, {2}. Not checked: {3}.':
    'Intet af det, du stadig tjekker, gav udslag i udsigten — {0}, {1}, {2}. Ikke tjekket: {3}.',
  'This device would not save your limits, so they will go back to the previous values next time you open FRANK. They are active for now.':
    'Denne enhed ville ikke gemme dine grænser, så de vender tilbage til de forrige værdier, næste gang du åbner FRANK. De er aktive nu.',
  'About FRANK — data, privacy and version': 'Om FRANK — data, privatliv og version',
  'Forecast built {0}.': 'Prognose bygget {0}.',
  '{0} hr': '{0} time',
  '{0} hrs': '{0} timer',
  '{0} hr {1} min': '{0} time {1} min',
  '{0} hrs {1} min': '{0} timer {1} min',
  'outlook': 'udsigt',
  'Outlook window, approximately {0}:00 to {1}:00 — more uncertain forecast':
    'Udsigtsvindue, cirka {0}:00 til {1}:00 — mere usikker prognose',
  'Launch window {0}:00 to {1}:00, {2}': 'Rovindue {0}:00 til {1}:00, {2}',
  'Launch window {0} to {1}, {2}': 'Rovindue {0} til {1}, {2}',
  ', partly outside daylight': ', delvist uden for dagslys',
  'no launch windows': 'ingen rovinduer',
  'Copy the launch window details:': 'Kopiér rovinduets detaljer:',
  '{0}: {1} {2}–{3}. Wind {4} m/s, waves {5} m.': '{0}: {1} {2}–{3}. Vind {4} m/s, bølger {5} m.',
  '{0} m/s wind · {1} m waves': '{0} m/s vind · {1} m bølger',
  'Ends near sunset ({0})': 'Slutter nær solnedgang ({0})',
  "A DMI {0} warning for {1} overlaps this window — it doesn't change this window's verdict; see the warning banner and DMI for details":
    '{0} DMI-varsel for {1} overlapper dette vindue — det ændrer ikke vinduets vurdering; se varselsbanneret og DMI for detaljer',
  'Longer-range outlook — more uncertain forecast.': 'Langtidsudsigt — mere usikker prognose.',
  'Tap to show this window in the graph.': 'Tryk for at vise dette vindue i grafen.',
  'Share this launch window': 'Del dette rovindue',
  'Launch window': 'Rovindue',
  'Outlook · more uncertain forecast': 'Udsigt · mere usikker prognose',
  'More uncertain forecast': 'Mere usikker prognose',
  'Night': 'Nat',
  'Now': 'Nu',
  'No launch windows in this forecast — the timeline above shows the marginal hours.':
    'Ingen rovinduer i denne prognose — tidslinjen ovenfor viser de marginale timer.',
  'Launch windows by day, {0} days': 'Rovinduer pr. dag, {0} dage',
  'Selected window': 'Valgt rovindue',

  // ── WeatherCharts ─────────────────────────────────────────────────────────
  'Show limits': 'Vis grænser',
  'Hide limits': 'Skjul grænser',
  'Tap or click a graph to select that hour': 'Tryk eller klik på en graf for at vælge den time',
  'Detailed graphs restricted to hourly available data': 'Detaljerede grafer viser kun timedata',
  'Wind & gusts': 'Vind & vindstød',
  'Water level': 'Niveau',
  'Air & water temp': 'Luft- & vandtemperatur',
  '{0} m · period {1} s': '{0} m · periode {1} s',
  'air {0}°': 'luft {0}°',
  'water {0}°': 'vand {0}°',
  'wind Take care {0}': 'vind Pas på {0}',
  'wind danger {0}': 'vind fare {0}',
  'wind/gust danger {0}': 'vind/vindstød fare {0}',
  'gust danger {0}': 'vindstød fare {0}',
  'waves Take care {0}': 'bølger Pas på {0}',
  'danger {0}': 'fare {0}',
  'water min {0}°': 'vand min {0}°',
  'danger below {0}°': 'fare under {0}°',

  // ── WarningStripe (+ planner warning badge) ───────────────────────────────
  'issued {0}': 'udstedt {0}',
  // "varsel"/"vejrvarsel" are neuter (et varsel), so the colour takes -t —
  // DMI itself writes "Gult varsel". These keys are only ever composed with
  // those two nouns, so the neuter form is correct at every call site.
  'Yellow': 'Gult',
  'Orange': 'Orange',
  'Red': 'Rødt',
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
  'Or choose another location:': 'Eller vælg et andet sted:',
  // ── TripProfilePanel ──────────────────────────────────────────────────────
  'Weather only': 'Kun vejr',
  'Weather only — turn off all your limits': 'Kun vejr — slå alle dine grænser fra',
  'Weather only — no limits applied': 'Kun vejr — ingen grænser anvendes',
  'switches every check off: FRANK shows the forecast and stops giving a verdict.':
    'slår alle tjek fra: FRANK viser prognosen og giver ikke længere en vurdering.',
  'Trip Profile': 'Turprofil',
  'About the modes': 'Om profilerne',
  'How cautious should FRANK be for you?': 'Hvor forsigtig skal FRANK være for dig?',
  'Chill': 'Rolig',
  'Normal': 'Normal',
  'Pro': 'Pro',
  'Custom': 'Egen',
  'The built-in profiles use these general wind and significant-wave bands:':
    'De indbyggede profiler bruger disse generelle grænser for vind og signifikant bølgehøjde:',
  'wind Take care from {0} m/s and Rough from {1} m/s; waves Take care from {2} m and Rough from {3} m.':
    'vind Pas på fra {0} m/s og Barskt fra {1} m/s; bølger Pas på fra {2} m og Barskt fra {3} m.',
  'These are FRANK starting points, not DKF safety limits or proof of skill. Local wind sectors and every other enabled rule may make a verdict stricter.':
    'Det er FRANKs udgangspunkter, ikke DKF-sikkerhedsgrænser eller bevis på færdigheder. Lokale vindsektorer og alle andre aktiverede regler kan gøre vurderingen strengere.',
  'Basis: Normal and Pro wind use the numeric conditions in':
    'Grundlag: Vindgrænserne for Normal og Pro bruger de talfastsatte forhold i',
  'See the': 'Se',
  'IPP 3 Touring norm': 'IPP 3 Touring-normen',
  'IPP 4 Touring norm': 'IPP 4 Touring-normen',
  "Touring IPP 2 has no numeric wind limit. Chill's 5 m/s Rough boundary and the red wave boundaries use":
    'Touring IPP 2 har ingen talfastsat vindgrænse. Rolig-profilens Barskt-grænse på 5 m/s og de røde bølgegrænser bruger',
  "DKF's 7 May 2026 sea-kayak norm": 'DKFs havkajaknorm af 7. maj 2026',
  "Chill's 4 m/s and the lower wave Take care boundaries are FRANK's conservative choices.":
    'Rolig-profilens 4 m/s og de nedre Pas på-grænser for bølger er FRANKs konservative valg.',
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
    'Ændringer træder i kraft med det samme og skifter dig til Egen. Vælg en forudindstilling i turprofilen øverst (Rolig, Normal, Pro) for at gå tilbage.',
  'Decrease {0}': 'Sænk {0}',
  'Increase {0}': 'Hæv {0}',
  'Wind — Take care from': 'Vind — Pas på fra',
  'Wind limit enabled': 'Vindgrænse slået til',
  'm/s wind': 'm/s vind',
  'wind Take care threshold; Danger stays {0} m/s above': 'Pas på-grænse for vind; Fare forbliver {0} m/s højere',
  '0 calm': '0 stille',
  'caution to {0}': 'pas på til {0}',
  '25 storm': '25 storm',
  'Gap to Danger': 'Afstand til Fare',
  'Take care from {0} m/s; +{1} m/s sets Danger from {2} m/s. The switch also checks gusts against it.':
    'Pas på fra {0} m/s; +{1} m/s sætter Fare fra {2} m/s. Kontakten tjekker også vindstød mod grænsen.',
  'Take care from {0} m; +{1} m sets Danger from {2} m. The switch adds the amber band between them.':
    'Pas på fra {0} m; +{1} m sætter Fare fra {2} m. Kontakten tilføjer det gule felt mellem grænserne.',
  'Check wind gusts': 'Tjek vindstød',
  'gusts up to {0} m/s rate Caution': 'vindstød op til {0} m/s vurderes Pas på',
  'wind Take care-to-Danger gap': 'afstand fra Pas på til Fare for vind',
  'Waves — Take care from': 'Bølger — Pas på fra',
  'Wave-height limit enabled': 'Bølgehøjdegrænse slået til',
  'm waves': 'm bølger',
  'wave Take care threshold; Danger stays {0} m above': 'Pas på-grænse for bølger; Fare forbliver {0} m højere',
  '0 flat': '0 fladt',
  '3 rough': '3 grov sø',
  'Show Take care wave band': 'Vis Pas på-bånd for bølger',
  'waves up to {0} m rate Caution': 'bølger op til {0} m vurderes Pas på',
  'wave Take care-to-Danger gap': 'afstand fra Pas på til Fare for bølger',
  'Min Water Temp': 'Min vandtemperatur',
  'Water temperature limit enabled': 'Grænse for vandtemperatur slået til',
  '°C water': '°C vand',
  'min water temperature': 'min vandtemperatur',
  '0 ice': '0 is',
  'safe from {0}°': 'sikker fra {0}°',
  '25 summer': '25 sommer',
  'Cold-water margin': 'Koldtvandsmargin',
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
  'Direction-specific caps for {0}, plus wind-against-water-level chop': 'Retningsbestemte lofter for {0}, plus krap sø ved vind mod vandstand',
  'Apply local wind-sector caps': 'Anvend lokale vindsektorlofter',
  'Local direction changes wave exposure and drift risk, so these caps can be stricter than the general profile.':
    'Den lokale retning ændrer bølgepåvirkning og afdriftsrisiko, så disse lofter kan være strengere end den generelle profil.',
  'from {0}': 'fra {0}',
  'Take care from': 'Pas på fra',
  '{0} Take care threshold': '{0} Pas på-grænse',
  'Danger from': 'Fare fra',
  '{0} danger threshold': '{0} faregrænse',
  'Directions are fixed to the local geography. Only the wind speeds are yours.':
    'Retningerne er fastlagt efter den lokale geografi. Kun vindstyrkerne er dine.',
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
  'Profile basis': 'Profilernes grundlag',
  'The built-in modes are FRANK starting points informed by DKF skill conditions. They are not DKF-issued safety limits, proof of competence, or a guarantee that a trip is safe.':
    'De indbyggede profiler er FRANKs udgangspunkter med afsæt i DKFs færdighedsforhold. De er ikke sikkerhedsgrænser udstedt af DKF, bevis på kompetence eller en garanti for, at en tur er sikker.',
  'general wind Take care from {0} m/s and Rough from {1} m/s; significant waves Take care from {2} m and Rough from {3} m.':
    'generel vind Pas på fra {0} m/s og Barskt fra {1} m/s; signifikante bølger Pas på fra {2} m og Barskt fra {3} m.',
  'Normal and Pro wind anchors use': 'Vindgrænserne for Normal og Pro bruger',
  'including the': 'herunder',
  "Touring IPP 2 gives no numeric wind limit. Chill's 5 m/s Rough boundary and the numeric red wave ceilings use":
    'Touring IPP 2 angiver ingen talfastsat vindgrænse. Rolig-profilens Barskt-grænse på 5 m/s og de talfastsatte røde bølgegrænser bruger',
  'Local wind sectors, gusts, temperature, weather, daylight, route, equipment, and club rules can all demand a stricter decision.':
    'Lokale vindsektorer, vindstød, temperatur, vejr, dagslys, rute, udstyr og klubregler kan alle kræve en strengere beslutning.',
  '1. Wave Height': '1. Bølgehøjde',
  'Significant wave height is checked against your Take care threshold and danger margin:':
    'Signifikant bølgehøjde tjekkes mod din Pas på-grænse og faremargen:',
  'Good to go:': 'Klar til at ro:',
  'Wave height is below your Take care threshold.': 'Bølgehøjden er under din Pas på-grænse.',
  'Take care:': 'Pas på:',
  'Wave height is at or above the Take care threshold, but below the danger threshold.':
    'Bølgehøjden er på eller over Pas på-grænsen, men under faregrænsen.',
  'Rough:': 'Barskt:',
  'Wave height is at or above the configured danger threshold.':
    'Bølgehøjden er på eller over den indstillede faregrænse.',
  'If the Take care band toggle is off, the amber band disappears: waves remain Good to go until the danger threshold.':
    'Er Pas på-båndet slået fra, forsvinder det gule felt: bølger forbliver Klar til at ro frem til faregrænsen.',
  'Wave labels use': 'Bølgebetegnelserne bruger',
  "WMO's sea-wave terms": 'WMOs betegnelser for søgang',
  'only as context; FRANK assesses the numeric height.':
    'kun som kontekst; FRANK vurderer den talfastsatte bølgehøjde.',
  'defines significant wave height as the mean height of the highest third of waves and notes that individual waves can be higher. FRANK separately cautions that the number does not describe local surf or short steep chop by itself.':
    'definerer signifikant bølgehøjde som middelhøjden af den højeste tredjedel af bølgerne og bemærker, at enkeltbølger kan være højere. FRANK advarer særskilt om, at tallet ikke i sig selv beskriver lokal brænding eller kort, krap sø.',
  '2. Wind Speed & Gusts': '2. Vindstyrke & vindstød',
  'MET supplies a 10-minute mean wind at 10 m and a peak gust based on a much shorter three-second average. FRANK checks both against the same Take care threshold; the Danger margin sets where each becomes Rough:':
    'MET leverer 10-minutters middelvind i 10 meters højde og et maksimalt vindstød baseret på et langt kortere 3-sekunders gennemsnit. FRANK tjekker begge mod samme Pas på-grænse; faremargenen bestemmer, hvor vurderingen bliver Barskt:',
  'Both mean wind and gusts are below the Take care threshold.':
    'Både middelvind og vindstød er under Pas på-grænsen.',
  'Mean wind or gusts are at or above the Take care threshold, but below the danger threshold.':
    'Middelvind eller vindstød er på eller over Pas på-grænsen, men under faregrænsen.',
  'Mean wind or gusts are at or above the danger threshold.':
    'Middelvind eller vindstød er på eller over faregrænsen.',
  "Normal's general wind band starts Take care at exactly 6.0 m/s and Rough at exactly 8.0 m/s. Enabled local sectors or other rules can make the result stricter. A threshold belongs to the stricter band.":
    'Normalprofilens generelle vindbånd starter Pas på ved præcis 6,0 m/s og Barskt ved præcis 8,0 m/s. Aktiverede lokale sektorer eller andre regler kan gøre resultatet strengere. En grænse hører til det strengere bånd.',
  'Mean-wind names follow': 'Navnene på middelvind følger',
  "DMI's Beaufort scale": 'DMIs Beaufortskala',
  'A gust is shown only as a number because a short gust is not a Beaufort mean-wind category. Measurement definitions:':
    'Et vindstød vises kun som et tal, fordi et kort vindstød ikke er en Beaufort-kategori for middelvind. Definitioner af målingerne:',
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
  'Danger': 'Fare',
  '4. Local Wind Sectors': '4. Lokale vindsektorer',
  'is enabled. Applies separate direction-specific limits for the wind sectors configured for {0}; these can make a profile stricter:':
    'er slået til. Anvender særskilte retningsbestemte grænser for vindsektorerne for {0}; de kan gøre en profil strengere:',
  'Take care from {0} m/s; danger from {1} m/s.': 'Pas på fra {0} m/s; fare fra {1} m/s.',
  'These limits use': 'Disse grænser bruger',
  'average wind speed only': 'kun middelvind',
  '(not gusts), as the chop that matters here is driven by sustained wind blowing across a long open stretch of water (its "fetch").':
    '(ikke vindstød), da den krappe sø, der betyder noget her, skabes af vedvarende vind hen over et langt frit stræk af vand (dets "fetch").',
  'Directions are fixed to the local geography; only the speed caps are yours to adjust.':
    'Retningerne er fastlagt efter den lokale geografi; kun vindlofterne kan du justere.',
  '5. Water Level': '5. Vandstand',
  'Water level comes from a storm-surge forecast model, not an astronomical tide table. The value shown is the forecast water level relative to mean sea level at the nearest model grid point, including wind setup and pressure effects.':
    'Vandstanden kommer fra en stormflodsmodel, ikke en astronomisk tidevandstabel. Den viste værdi er den forudsagte vandstand i forhold til middelvandstand ved nærmeste modelpunkt, inklusive vindstuvning og trykeffekter.',
  'High Water Filter:': 'Højvandsfilter:',
  'Water level ≥ +10 cm. Useful for shallow areas.': 'Vandstand ≥ +10 cm. Nyttigt i lavvandede områder.',
  'Low Water Filter:': 'Lavvandsfilter:',
  'Water level ≤ -10 cm.': 'Vandstand ≤ -10 cm.',
  'Rising Only:': 'Kun stigende:',
  'Water level rises through the whole launch window.': 'Vandstanden stiger gennem hele rovinduet.',
  '6. Weather Condition (Rain, Snow, Sleet, Fog, Thunder)': '6. Vejrforhold (regn, sne, slud, tåge, torden)',
  "The weather condition comes straight from the forecast's own symbol (MET Norway's symbol_code) — FRANK does not compute its own rain or lightning judgement. Each condition maps to a severity:":
    'Vejrforholdet kommer direkte fra prognosens eget symbol (MET Norways symbol_code) — FRANK beregner ikke sin egen regn- eller lynvurdering. Hvert forhold svarer til en alvorlighed:',
  'clear, cloudy, light drizzle, and light rain — no weather flag.': 'klart, skyet, let støvregn og let regn — ingen vejrbemærkning.',
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
  'among them. A rule can only raise the severity (Good to go → Take care → Rough) — no rule can lower a rating another rule has already set:':
    'blandt dem. En regel kan kun hæve alvorligheden (Klar til at ro → Pas på → Barskt) — ingen regel kan sænke en vurdering, en anden regel allerede har sat:',
  'If any rule reaches Rough (for example a thunderstorm or heavy-rain forecast), the whole hour is Rough, regardless of how calm everything else looks.':
    'Hvis én regel giver vurderingen Barskt (for eksempel varslet tordenvejr eller kraftig regn), er hele timen Barskt, uanset hvor roligt alt andet ser ud.',
  'Take-care-only rules (wind-against-water clash > 4 m/s, nighttime) never raise an hour above Take care on their own.':
    'Regler, der højst giver Pas på (vind mod vandstand > 4 m/s, nat), hæver aldrig en time over Pas på alene.',
  'Every triggered rule is listed in the assessment, so you always see all reasons — not just the worst one.':
    'Hver udløst regel vises i vurderingen, så du altid ser alle begrundelser — ikke kun den værste.',
  '8. Water Temperature': '8. Vandtemperatur',
  "Cold shock and hypothermia risk, checked against your configured limits. The defaults are conservative starting points — set them to your own club's rules, your gear, and the season:":
    'Risiko for kuldechok og hypotermi, tjekket mod dine indstillede grænser. Standardværdierne er forsigtige udgangspunkter — sæt dem efter din klubs regler, dit udstyr og årstiden:',
  'Good to go for general paddling clothing.': 'Klar til at ro med almindeligt rotøj.',
  'Take care. Thermal layers or wetsuit strongly recommended.': 'Pas på. Termolag eller våddragt anbefales kraftigt.',
  'Rough. Drysuit or heavy wetsuit required.': 'Barskt. Tørdragt eller tyk våddragt påkrævet.',
  '9. Daylight Rule': '9. Dagslysregel',
  'Many clubs prohibit paddling between sunset and sunrise without navigation lights and permission, so when this rule is on, hourly forecasts outside daylight are marked Take care (turn it off if night paddling is fine for you). A longer-range outlook block is marked Take care unless its whole period is daylight. Launch windows are handled separately: periods with no complete daylight hour are dropped, and partial periods show only their longest continuous daylight part.':
    'Mange klubber forbyder roning mellem solnedgang og solopgang uden lanterner og tilladelse, så når denne regel er slået til, markeres timeprognoser uden for dagslys som Pas på (slå den fra, hvis natroning er i orden for dig). En blok i langtidsudsigten markeres som Pas på, medmindre hele perioden ligger i dagslys. Rovinduer håndteres separat: perioder uden en hel time i dagslys udelades, og delvise perioder viser kun deres længste sammenhængende del i dagslys.',
  '10. Launch Windows': '10. Rovinduer',
  'A launch window is an unbroken run of Good-to-go hours — an hour rated Take care or Rough breaks the run:':
    'Et rovindue er en ubrudt række af Klar til at ro-timer — en time vurderet Pas på eller Barskt bryder rækken:',
  'Minimum duration:': 'Minimumsvarighed:',
  'runs shorter than your Min Duration setting are not shown.': 'forløb kortere end din min varighed vises ikke.',
  'Day boundaries:': 'Døgngrænser:',
  'hourly windows split at local midnight, so each belongs to one calendar day; longer-range outlook windows can run past it (the end time then shows its day).':
    'timevinduer deles ved lokal midnat, så hvert hører til én kalenderdag; langtidsudsigtens vinduer kan løbe forbi den (sluttiden viser da sin dag).',
  'Longer range:': 'Længere sigt:',
  'beyond the hourly forecast, coarser outlook blocks (6 hours, occasionally 12) form windows marked "more uncertain forecast" — treat them as hints, not commitments.':
    'ud over timeprognosen danner grovere udsigtsblokke (6 timer, af og til 12) vinduer markeret "mere usikker prognose" — tag dem som fingerpeg, ikke løfter.',
  'Close': 'Luk',
};
