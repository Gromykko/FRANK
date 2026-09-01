// Danish dictionary. Keys are the FULL English source strings (readable call
// sites; a missing entry soft-fails to English). {0}/{1}… are argument slots.
// Organized by the component/module the strings live in.
export const da: Record<string, string> = {
  // ── Shared verdict & rating words ──────────────────────────────────────────
  'Within limits': 'Inden for grænserne',
  'Check before launch': 'Tjek før du tager på vandet',
  'Not recommended': 'Frarådes',
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
  'Limits are off: raw forecast only': 'Grænserne er slået fra: kun rå prognose',
  'No enabled check was triggered': 'Ingen aktive tjek gav udslag',
  'Read the checks below': 'Se, hvad du skal tjekke, nedenfor',
  'Choose another time': 'Vælg et andet tidspunkt',
  'Your personal limits are off.': 'Dine personlige grænser er slået fra.',
  'Off duty. You are the captain now': 'Ikke på vagt. Du er kaptajnen nu',
  'Switch to dark theme': 'Skift til mørkt tema',
  'Switch to light theme': 'Skift til lyst tema',
  'built {0}': 'bygget {0}',
  'The forecast could not be refreshed. You are seeing data from {0} — {1} old. FRANK retries by itself roughly every 10 minutes.':
    'Prognosen kunne ikke opdateres. Du ser data fra {0} — {1} gamle. FRANK prøver selv igen cirka hvert 10. minut.',
  'This forecast has not updated as expected. You are seeing data from {0} — {1} old, and FRANK is checking again.':
    'Prognosen er ikke blevet opdateret som forventet. Du ser data fra {0} — {1} gamle, og FRANK tjekker igen.',
  'The saved forecast time could not be verified. Check an official source before launching.':
    'Tidspunktet for den gemte prognose kunne ikke bekræftes. Tjek en officiel kilde, før du tager ud.',
  // Offline AND old: the age warning still fires (a paddler on the water needs
  // it), but nothing is "failing" — there is no connection to try over.
  'You have been offline for a while, so this forecast is from {0} — {1} old. It will update by itself once you are back online.':
    'Du har været offline et stykke tid, så denne prognose er fra {0} — {1} gammel. Den opdateres af sig selv, når du er online igen.',
  'Hourly forecast timeline': 'Timeprognosens tidslinje',
  // Explains the striped, time-span columns where the matrix stops being hourly.
  // ── Meteogram outlook legend ──────────────────────────────────────────────
  'Columns like 02–08 show a 6-hour block.': 'Kolonner som 02–08 viser en 6-timers blok.',
  'Waves and water temperature: the highest waves and coldest water.':
    'Bølger og vandtemperatur: højeste bølger og koldeste vand.',
  'Wind and air temperature show the forecast at the start of the block.':
    'Vind og lufttemperatur viser prognosen ved blokkens start.',
  'Water level: above mean': 'Niveau: over middel',
  'below mean': 'under middel',
  'spans both sides': 'på begge sider',
  'or at mean': 'eller ved middel',
  'Water level: above mean, below mean, spans both sides, or at mean.':
    'Niveau: over middel, under middel, på begge sider eller ved middel.',
  'Tap a block for its numbers.': 'Tryk på en blok for at se tallene.',
  '6-hour blocks': '6-timers blokke',
  'How to read the 6-hour blocks': 'Sådan læser du 6-timers blokkene',
  'The bar under each column: green {0}, amber {1}, red {2}.':
    'Bjælken under hver kolonne: grøn {0}, gul {1}, rød {2}.',
  'Gusts are not forecast for these blocks.': 'Vindstød varsles ikke for disse blokke.',
  'Detailed Graphs': 'Detaljerede grafer',
  'Wind, waves, water level, and temperature': 'Vind, bølger, niveau og temperatur',
  'Loading charts...': 'Indlæser grafer...',
  'Weather data by MET Norway': 'Vejrdata fra MET Norway',
  ', waves & water by DMI ({0}) for {1}.': ', bølger & vandstand fra DMI ({0}) for {1}.',
  'Warnings by': 'Varsler fra',
  'Time delays between this website and the www.meteoalarm.org website are possible. For the most up-to-date awareness information as published by the participating National Meteorological and Hydrological Services, please refer to www.meteoalarm.org.':
    'Der kan forekomme tidsforsinkelser mellem denne hjemmeside og hjemmesiden www.meteoalarm.org. For de senest opdaterede varslingsoplysninger, som de deltagende nationale meteorologiske og hydrologiske tjenester har offentliggjort, henvises der til www.meteoalarm.org.',
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
  'Forecasts ready now': 'Prognoser klar nu',
  'ready': 'klar',
  'preparing': 'klargøres',
  'FRANK could not save that location in this browser. Try again or check the browser’s site-data settings.':
    'FRANK kunne ikke gemme stedet i denne browser. Prøv igen, eller kontrollér browserens indstillinger for webstedsdata.',

  // ── StatusBar ──────────────────────────────────────────────────────────────
  'Refresh forecast': 'Opdater prognosen',
  'Switch to English': 'Skift til engelsk',
  'Switch to Danish': 'Skift til dansk',
  'Detailed graph summary': 'Oversigt over detaljerede grafer',
  'Detailed weather graphs showing wind, gusts, waves, water level, and temperature. All values are also available in text in the hourly forecast timeline table above.':
    'Detaljerede vejrgrafer for vind, vindstød, bølger, vandstand og temperatur. Alle værdier findes også som tekst i timeoversigten ovenfor.',

  // ── FRANK's dot-matrix phrases ─────────────────────────────────────────────
  'The available readings are within your limits': 'De tilgængelige målinger er inden for dine grænser',
  'Nothing in the available forecast crossed your limits': 'Intet i den tilgængelige prognose overskred dine grænser',
  'The {0} fits your limits': '{0} passer til dine grænser',
  'Check the details before you launch': 'Tjek detaljerne, før du tager på vandet',
  'The {0} needs a second look': '{0} kræver et ekstra blik',
  'Pause and check the conditions': 'Stop op, og tjek forholdene',
  'Nej tak. The {0} says no': 'Nej tak. {0} siger nej',
  'Even the Vikings called in sick today': 'Selv vikingerne har meldt sig syge i dag',
  'The {0} will still be here tomorrow': '{0} er her også i morgen',
  'The sea is angry. Coffee instead': 'Havet er vredt. Kaffe i stedet',
  'Outside your limits. Pick another time': 'Uden for dine grænser. Vælg et andet tidspunkt',
  'Best enjoyed from the shore today': 'Nydes bedst fra land i dag',

  // ── Cache status (cacheStatusView.ts) ─────────────────────────────────────
  'Offline': 'Offline',
  'Saved forecast': 'Gemt prognose',
  'Saved forecast · {0} old': 'Gemt prognose · {0} gammel',
  'wind': 'vind',
  'water level': 'vandstand',
  'waves': 'bølger',
  'marine data': 'havdata',
  'Delayed update: {0}': 'Forsinket opdatering: {0}',
  'Update in progress…': 'Opdatering i gang…',
  'Checking…': 'Tjekker…',
  'Couldn’t refresh': 'Kunne ikke opdatere',
  '{0} min': '{0} min',
  '{0} h': '{0} t',
  '{0} d': '{0} d',
  'Showing saved forecast from {0}.': 'Viser gemt prognose fra {0}.',
  'Showing saved forecast.': 'Viser gemt prognose.',
  'Showing forecast from {0}.': 'Viser prognose fra {0}.',
  'Offline · {0}': 'Offline · {0}',
  'Update in progress · {0}': 'Opdatering i gang · {0}',
  'Saved forecast from {0}.': 'Gemt prognose fra {0}.',
  'Saved forecast.': 'Gemt prognose.',
  'Couldn’t refresh · {0}': 'Kunne ikke opdatere · {0}',
  'Forecast from {0}.': 'Prognose fra {0}.',
  'Forecast from {0}': 'Prognose fra {0}',
  'Advisory only — FRANK does not replace official warnings, club rules, or your own look at the water. You are responsible for the decision to launch.':
    'Kun vejledende — FRANK erstatter ikke officielle varsler, klubbens regler eller dit eget blik på vandet. Du har selv ansvaret for beslutningen om at tage ud.',
  'The forecast came back with no hours in it.': 'Prognosen kom tilbage uden timer i.',
  'Charts are unavailable right now. The forecast above is unaffected.':
    'Graferne er ikke tilgængelige lige nu. Prognosen ovenfor er upåvirket.',
  // Missing-reading wording — see analyzeSafetyConditions.
  'No reading for {0} this hour. FRANK cannot assess it — check another source.':
    'Ingen måling af {0} denne time. FRANK kan ikke vurdere den — tjek en anden kilde.',
  'No reading for {0} in this period. FRANK cannot assess it — check another source.':
    'Ingen måling af {0} i perioden. FRANK kan ikke vurdere den — tjek en anden kilde.',
  'wind speed': 'vindhastighed',
  'wind gusts': 'vindstød',
  'wind direction': 'vindretning',
  'wave height': 'bølgehøjde',
  'water temperature': 'vandtemperatur',
  'Unknown': 'Ukendt',
  'Forecast days': 'Prognosedage',

  // ── Safety reasons (analyzeSafetyConditions.ts) ───────────────────────────
  'Wind speed: {0} m/s ({1}). Above your maximum of {2} m/s.':
    'Vindstyrke: {0} m/s ({1}). Over dit maksimum på {2} m/s.',
  'Wind speed: {0} m/s ({1}). At your maximum of {2} m/s.':
    'Vindstyrke: {0} m/s ({1}). Ved dit maksimum på {2} m/s.',
  'Wind speed: {0} m/s ({1}). {2} m/s below your maximum of {3} m/s.':
    'Vindstyrke: {0} m/s ({1}). {2} m/s under dit maksimum på {3} m/s.',
  'Wind gusts: {0} m/s. Above your maximum of {1} m/s.':
    'Vindstød: {0} m/s. Over dit maksimum på {1} m/s.',
  'Wind gusts: {0} m/s. At your maximum of {1} m/s.':
    'Vindstød: {0} m/s. Ved dit maksimum på {1} m/s.',
  'Wind gusts: {0} m/s. {1} m/s below your maximum of {2} m/s.':
    'Vindstød: {0} m/s. {1} m/s under dit maksimum på {2} m/s.',
  'Wind speed: {0} m/s ({1}). {2} wind ({3}°) is above your {4} m/s maximum.':
    'Vindstyrke: {0} m/s ({1}). {2} vind ({3}°) er over dit maksimum på {4} m/s.',
  'Wind speed: {0} m/s ({1}). {2} wind ({3}°) is at your {4} m/s maximum.':
    'Vindstyrke: {0} m/s ({1}). {2} vind ({3}°) er ved dit maksimum på {4} m/s.',
  'Wind speed: {0} m/s ({1}). {2} wind ({3}°) is {4} m/s below your {5} m/s maximum.':
    'Vindstyrke: {0} m/s ({1}). {2} vind ({3}°) er {4} m/s under dit maksimum på {5} m/s.',
  'Water temperature: {0}°C. This is at or below your {1}°C lower limit.':
    'Vandtemperatur: {0}°C. Det er ved eller under din nedre grænse på {1}°C.',
  'Water temperature: {0}°C. This is below your {1}°C check boundary.':
    'Vandtemperatur: {0}°C. Det er under din kontrolgrænse på {1}°C.',
  'Wave height: {0} m ({1}). Above your maximum of {2} m.':
    'Bølgehøjde: {0} m ({1}). Over dit maksimum på {2} m.',
  'Wave height: {0} m ({1}). At your maximum of {2} m.':
    'Bølgehøjde: {0} m ({1}). Ved dit maksimum på {2} m.',
  'Wave height: {0} m ({1}). {2} m below your maximum of {3} m.':
    'Bølgehøjde: {0} m ({1}). {2} m under dit maksimum på {3} m.',
  '{0}. These conditions are not recommended.': '{0}. Disse forhold frarådes.',
  '{0}. Check visibility and conditions before launch.':
    '{0}. Tjek sigtbarheden og forholdene, før du tager på vandet.',
  'Nighttime: outside paddling hours.': 'Nat: uden for rotimerne.',
  'Daylight: part of this period is outside paddling hours.':
    'Dagslys: en del af perioden ligger uden for rotimerne.',
  'Daylight: no complete hour of this period is within paddling hours.':
    'Dagslys: ingen hel time i perioden ligger inden for rotimerne.',
  'Daylight: sunrise or sunset is missing, so FRANK cannot clear this period.':
    'Dagslys: solopgang eller solnedgang mangler, så FRANK kan ikke frikende perioden.',
  'No check was triggered: {0}, {1}, {2}.': 'Ingen tjek gav udslag: {0}, {1}, {2}.',
  'No outlook check was triggered: {0}, {1}, {2}.': 'Ingen tjek i langtidsudsigten gav udslag: {0}, {1}, {2}.',
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

  // ── MET Weathericons symbol descriptions ─────────────────────────────────
  // English keys are MET's official legend verbatim. MET publishes no Danish
  // column; these are DMI-aligned Danish terms. In particular, MET `lightrain`
  // means light rain, not the distinct DMI phenomenon finregn/drizzle.
  'Clear sky': 'Klart vejr',
  'Fair': 'Let skyet',
  'Partly cloudy': 'Delvist skyet',
  'Cloudy': 'Skyet',
  'Light rain showers': 'Lette regnbyger',
  'Rain showers': 'Regnbyger',
  'Heavy rain showers': 'Kraftige regnbyger',
  'Light rain showers and thunder': 'Lette regnbyger med torden',
  'Rain showers and thunder': 'Regnbyger med torden',
  'Heavy rain showers and thunder': 'Kraftige regnbyger med torden',
  'Light sleet showers': 'Lette sludbyger',
  'Sleet showers': 'Sludbyger',
  'Heavy sleet showers': 'Kraftige sludbyger',
  'Light sleet showers and thunder': 'Lette sludbyger med torden',
  'Sleet showers and thunder': 'Sludbyger med torden',
  'Heavy sleet showers and thunder': 'Kraftige sludbyger med torden',
  'Light snow showers': 'Lette snebyger',
  'Snow showers': 'Snebyger',
  'Heavy snow showers': 'Kraftige snebyger',
  'Light snow showers and thunder': 'Lette snebyger med torden',
  'Snow showers and thunder': 'Snebyger med torden',
  'Heavy snow showers and thunder': 'Kraftige snebyger med torden',
  'Light rain': 'Let regn',
  'Rain': 'Regn',
  'Heavy rain': 'Kraftig regn',
  'Light rain and thunder': 'Let regn med torden',
  'Rain and thunder': 'Regn med torden',
  'Heavy rain and thunder': 'Kraftig regn med torden',
  'Light sleet': 'Let slud',
  'Sleet': 'Slud',
  'Heavy sleet': 'Kraftig slud',
  'Light sleet and thunder': 'Let slud med torden',
  'Sleet and thunder': 'Slud med torden',
  'Heavy sleet and thunder': 'Kraftig slud med torden',
  'Light snow': 'Let sne',
  'Snow': 'Sne',
  'Heavy snow': 'Kraftig sne',
  'Light snow and thunder': 'Let sne med torden',
  'Snow and thunder': 'Sne med torden',
  'Heavy snow and thunder': 'Kraftig sne med torden',
  'Fog': 'Tåge',
  'Unknown weather': 'Ukendt vejr',

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
  'Some hours are within your limits, but never {0} in a row. Lower the minimum duration in Your Limits, or try another trip mode.':
    'Nogle timer ligger inden for dine grænser, men aldrig {0} i træk. Sænk minimumsvarigheden under Dine grænser, eller prøv en anden turprofil.',
  'No launch windows fit all your selected checks yet. Open an hour to see what needs attention, or check again after the forecast updates.':
    'Der er endnu ingen rovinduer, som opfylder alle dine valgte tjek. Åbn en time for at se, hvad du skal være opmærksom på, eller tjek igen, når prognosen er opdateret.',
  'No launch windows pass all your checks. One continuous stretch is long enough, but it contains at least one hour rated Check before launch. Review it in the timeline above.':
    'Ingen rovinduer opfylder alle dine tjek. Én sammenhængende periode er lang nok, men den indeholder mindst én time, der er vurderet Tjek før du tager på vandet. Gennemgå den i tidslinjen ovenfor.',
  'No launch windows pass all your checks. {0} continuous stretches are long enough, but each contains at least one hour rated Check before launch. Review them in the timeline above.':
    'Ingen rovinduer opfylder alle dine tjek. {0} sammenhængende perioder er lange nok, men hver af dem indeholder mindst én time, der er vurderet Tjek før du tager på vandet. Gennemgå dem i tidslinjen ovenfor.',
  'Your personal limits are switched off, so there is nothing to measure the forecast against and no window can be recommended. Turn a limit back on to see suggested windows.':
    'Dine personlige grænser er slået fra, så der er intet at måle prognosen op imod, og intet vindue kan anbefales. Slå en grænse til igen for at se foreslåede vinduer.',
  'No enabled check was triggered: {0}, {1}, {2}. Not checked: {3}.':
    'Ingen aktive tjek gav udslag: {0}, {1}, {2}. Ikke tjekket: {3}.',
  'No enabled outlook check was triggered: {0}, {1}, {2}. Not checked: {3}.':
    'Ingen aktive tjek i langtidsudsigten gav udslag: {0}, {1}, {2}. Ikke tjekket: {3}.',
  'This device would not save your limits, so they will go back to the previous values next time you open FRANK. They are active for now.':
    'Denne enhed ville ikke gemme dine grænser, så de vender tilbage til de forrige værdier, næste gang du åbner FRANK. De er aktive nu.',
  'About FRANK — data, privacy and version': 'Om FRANK — data, privatliv og version',
  'Forecast built {0}.': 'Prognose bygget {0}.',
  '{0} hr': '{0} time',
  '{0} hrs': '{0} timer',
  '{0} hr {1} min': '{0} time {1} min',
  '{0} hrs {1} min': '{0} timer {1} min',
  'outlook': 'udsigt',
  'Outlook window, approximately {0}:00 to {1}:00':
    'Udsigtsvindue, cirka {0}:00 til {1}:00',
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
  'Tap to show this window in the graph.': 'Tryk for at vise dette vindue i grafen.',
  'Share this launch window': 'Del dette rovindue',
  'Launch window': 'Rovindue',
  'Night': 'Nat',
  'Now': 'Nu',
  'Launch windows by day, {0} days': 'Rovinduer pr. dag, {0} dage',
  'Selected window': 'Valgt rovindue',

  // ── WeatherCharts ─────────────────────────────────────────────────────────
  'Show limits': 'Vis grænser',
  'Hide limits': 'Skjul grænser',
  'Tap or click a graph to select that hour': 'Tryk eller klik på en graf for at vælge den time',
  'Detailed graphs restricted to hourly available data': 'Detaljerede grafer viser kun timedata',
  'Shown thresholds: {0}.': 'Viste grænser: {0}.',
  'No active limits to show.': 'Ingen aktive grænser at vise.',
  'wind check {0} m/s, maximum {1} m/s': 'vind tjekkes fra {0} m/s, maksimum {1} m/s',
  'gust check {0} m/s, derived maximum {1} m/s': 'vindstød tjekkes fra {0} m/s, beregnet maksimum {1} m/s',
  'wave check {0} m, maximum {1} m': 'bølger tjekkes fra {0} m, maksimum {1} m',
  'water temperature check below {0}°C, not recommended at or below {1}°C':
    'vandtemperatur tjekkes under {0} °C, frarådes ved eller under {1} °C',
  'wind check {0}': 'vindtjek {0}',
  'gust check {0}': 'vindstødstjek {0}',
  'wave check {0}': 'bølgetjek {0}',
  'Wind & gusts': 'Vind & vindstød',
  'Water level': 'Niveau',
  'Air & water temp': 'Luft- & vandtemperatur',
  '{0} m · period {1} s': '{0} m · periode {1} s',
  'air {0}°': 'luft {0}°',
  'water {0}°': 'vand {0}°',
  'wind maximum {0}': 'maks. vind {0}',
  'derived gust maximum {0}': 'beregnet maks. vindstød {0}',
  'wave maximum {0}': 'maks. bølgehøjde {0}',
  'check below {0}°': 'tjek under {0}°',
  'not recommended at or below {0}°': 'frarådes ved eller under {0}°',

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
  'Medium': 'Mellem',
  'Pro': 'Pro',
  'Custom': 'Egen',
  'The built-in profiles start with these maximum conditions:':
    'De indbyggede profiler tager udgangspunkt i disse maksimumværdier:',
  'maximum mean wind {0} m/s; maximum significant waves {1} m.':
    'maksimal middelvind {0} m/s; maksimal signifikant bølgehøjde {1} m.',
  'These are starting points, not DKF safety guarantees or proof of skill. Optional local wind sectors and every other enabled rule may make the result stricter.':
    'Det er udgangspunkter, ikke sikkerhedsgarantier fra DKF eller bevis på færdigheder. Valgfrie lokale vindsektorer og alle andre aktiverede regler kan gøre resultatet strengere.',
  'Basis: Medium and Pro wind use the numeric conditions in':
    'Grundlag: Vindgrænserne for Mellem og Pro bruger de talfastsatte forhold i',
  'See the': 'Se',
  'IPP 3 Touring norm': 'IPP 3 Touring-normen',
  'IPP 4 Touring norm': 'IPP 4 Touring-normen',
  'Touring IPP 2 has no numeric wind limit. The Chill wind maximum and all three wave maxima use':
    'Touring IPP 2 har ingen talfastsat vindgrænse. Vindmaksimum for Rolig og alle tre bølgemaksima bygger på',
  "DKF's 7 May 2026 sea-kayak norm": 'DKFs havkajaknorm af 7. maj 2026',
  'The source documents describe training and assessment conditions, not guaranteed safe conditions.':
    'Kildedokumenterne beskriver forhold ved træning og prøver, ikke garanteret sikre forhold.',
  'is your own set: change anything in Your Limits below and it lands there.':
    'er dit eget sæt: ændr hvad som helst i Dine grænser nedenfor, og det lander der.',
  'Picking a mode updates the exact numbers in Your Limits. The manual explains every rule.':
    'Når du vælger en profil, opdateres de præcise tal under Dine grænser. Manualen forklarer hver regel.',
  'Trip mode': 'Turprofil',

  // ── SafetyLimitsPanel ─────────────────────────────────────────────────────
  'Your Limits': 'Dine grænser',
  'How FRANK Decides': 'Sådan vurderer FRANK',
  'Your personal limits': 'Dine personlige grænser',
  'Your personal limits · {0}': 'Dine personlige grænser · {0}',
  'Any change applies immediately and switches you to Custom.':
    'Enhver ændring træder i kraft med det samme og skifter dig til Egen.',
  'Decrease {0}': 'Sænk {0}',
  'Increase {0}': 'Hæv {0}',
  'Maximum wind': 'Maksimal vindstyrke',
  'Wind limit enabled': 'Vindgrænse slået til',
  'm/s wind': 'm/s vind',
  '0 calm': '0 stille',
  '25 storm': '25 storm',
  'Use forecast gusts in the verdict': 'Brug varslede vindstød i vurderingen',
  'Check from {0} m/s · derived maximum {1} m/s ({2}× the wind maximum).':
    'Tjek fra {0} m/s · beregnet maksimum {1} m/s ({2} × vindmaksimum).',
  'Check from {0} {1} · Not recommended above {2} {1}':
    'Tjek fra {0} {1} · frarådes over {2} {1}',
  'Check from {0} m/s · maximum {1} m/s':
    'Tjek fra {0} m/s · maksimum {1} m/s',
  'm/s': 'm/s',
  'm': 'm',
  "Each check point sits at 80% of the maximum you set. It is FRANK's own headroom rule — open the manual above for the detail.":
    'Hvert tjekpunkt ligger på 80% af det maksimum, du sætter. Det er FRANKs egen margenregel — åbn manualen ovenfor for detaljerne.',
  'Wind check from {0} m/s. If gust checking is on, gusts are checked from {1} m/s with a derived maximum of {2} m/s.':
    'Vind tjekkes fra {0} m/s. Hvis kontrol af vindstød er slået til, tjekkes de fra {1} m/s med et beregnet maksimum på {2} m/s.',
  'Wave check from {0} m.': 'Bølger tjekkes fra {0} m.',
  'Maximum waves': 'Maksimal bølgehøjde',
  'Wave-height limit enabled': 'Bølgehøjdegrænse slået til',
  'm waves': 'm bølger',
  '0 flat': '0 fladt',
  '3 rough': '3 grov sø',
  'Water temperature': 'Vandtemperatur',
  'Check below {0}°C · Not recommended at or below {1}°C':
    'Tjek under {0}°C · frarådes ved eller under {1}°C',
  'Water temperature limit enabled': 'Grænse for vandtemperatur slået til',
  '°C water': '°C vand',
  'water temperature check boundary': 'kontrolgrænse for vandtemperatur',
  '0 ice': '0 is',
  'Within limit from {0}°': 'Inden for grænsen fra {0}°',
  '25 summer': '25 sommer',
  'Not recommended at or below': 'Frarådes ved eller under',
  'Set the colder boundary directly': 'Indstil den koldere grænse direkte',
  'water temperature Not recommended boundary':
    'grænse for vandtemperatur, hvor turen frarådes',
  'Optional local wind sectors': 'Valgfrie lokale vindsektorer',
  'Planning rules': 'Planlægningsregler',
  'Min Duration': 'Min varighed',
  'Shortest usable launch window': 'Korteste brugbare rovindue',
  '1 hour': '1 time',
  '{0} hours': '{0} timer',
  'Daylight Only': 'Kun dagslys',
  'Night hours need a check before launch': 'Nattetimer skal tjekkes, før du tager på vandet',
  'Local wind sectors': 'Lokale vindsektorer',
  'Optional stricter limits for {0}, based on broad area estimates':
    'Valgfrie, strammere grænser for {0}, baseret på grove skøn for området',
  'Apply optional wind-sector limits': 'Anvend valgfrie vindsektorgrænser',
  'These optional limits are broad FRANK estimates, not current kayak-club rules. A matching sector can only make the general wind result stricter.':
    'De valgfrie grænser er FRANKs grove skøn for et større område, ikke aktuelle kajakklubregler. En sektor, der passer til vindretningen, kan kun gøre den generelle vindvurdering strengere.',
  'from {0}': 'fra {0}',
  '{0} maximum wind': 'maksimal vind for {0}',
  'The bearings are fixed. You can adjust only the wind speeds.':
    'Retningerne ligger fast. Du kan kun justere vindstyrkerne.',
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
  "FRANK's built-in profiles use DKF training and assessment conditions as starting points. DKF did not publish them as safety limits. Choosing a profile does not prove competence or make a trip safe.":
    'FRANKs indbyggede profiler tager udgangspunkt i DKFs forhold for træning og prøver. DKF har ikke offentliggjort dem som sikkerhedsgrænser. Valget af en profil beviser ikke dine færdigheder og gør ikke i sig selv en tur sikker.',
  'The Medium and Pro wind limits draw on': 'Vindgrænserne for Mellem og Pro bygger på',
  'including the': 'herunder',
  'Touring IPP 2 gives no numeric wind limit. The Chill wind maximum and all three wave maxima use':
    'Touring IPP 2 angiver ingen talfastsat vindgrænse. Vindmaksimum for Rolig og alle tre bølgemaksima bygger på',
  'Forecast points and model grids': 'Prognosepunkter og modelgitre',
  'FRANK asks for one fixed reference point in each area. It does not average the whole fjord or follow your route.':
    'FRANK henter prognosen for ét fast punkt i hvert område. Den beregner ikke et gennemsnit for hele fjorden og følger ikke din rute.',
  'Area': 'Område',
  'Requested point': 'Punkt sendt til kilden',
  'interpolates its weather model to the requested point and adjusts air temperature for height. The result is still a forecast for an area around that point, not a measurement at the kayak.':
    'beregner vejret ved det ønskede punkt ud fra modelgitteret og korrigerer lufttemperaturen for højden. Det er stadig en prognose for området omkring punktet, ikke en måling ved kajakken.',
  'returns the closest model grid point for water and waves. That point can differ from the coordinate FRANK requested, and the water and wave models use different grids. FRANK checks that a complete marine series is usable before it replaces the previous data, but it does not average several grid points.':
    'returnerer det nærmeste modelpunkt for havdata. Punktet kan ligge et andet sted end koordinaten, FRANK bad om, og modellerne for vand og bølger bruger forskellige gitre. FRANK kontrollerer, at en komplet havprognose kan bruges, før den erstatter de tidligere data, men beregner ikke et gennemsnit af flere modelpunkter.',
  'FRANK accepts a complete marine forecast even if DMI returns a different grid point than before. The technical status page records the requested and returned points so the change can be investigated. It does not add a warning to the public forecast or change the verdict.':
    'FRANK bruger en komplet havprognose, selv om DMI returnerer et andet modelpunkt end tidligere. Den tekniske statusside viser både det ønskede og det returnerede punkt, så ændringen kan undersøges. Det giver ingen advarsel i den offentlige prognose og ændrer ikke vurderingen.',
  'These documents describe training and assessment conditions, not guaranteed safe conditions. Local wind sectors, gusts, temperature, weather, daylight, route, equipment, and club rules may all require a stricter decision.':
    'Dokumenterne beskriver forhold ved træning og prøver, ikke garanteret sikre forhold. Lokale vindsektorer, vindstød, temperatur, vejr, dagslys, rute, udstyr og klubregler kan alle tale for en strengere vurdering.',
  "The automatic 80% check point is FRANK's own headroom rule, not a threshold published by DKF or IPP.":
    'Det automatiske tjekpunkt ved 80% er FRANKs egen margenregel, ikke en grænse offentliggjort af DKF eller IPP.',
  '1. How rules combine': '1. Sådan kombineres reglerne',
  '3. Wave height': '3. Bølgehøjde',
  'FRANK compares significant wave height with the maximum in your profile:':
    'FRANK sammenligner den signifikante bølgehøjde med maksimum i din profil:',
  'Within limits:': 'Inden for grænserne:',
  'Wave height is below {0} m.': 'Bølgehøjden er under {0} m.',
  'Wave height is from {0} through {1} m.': 'Bølgehøjden ligger fra {0} til og med {1} m.',
  'Not recommended:': 'Frarådes:',
  'Wave height is above {0} m.': 'Bølgehøjden er over {0} m.',
  'Wave labels use': 'Bølgebetegnelserne bruger',
  "WMO's sea-wave terms": 'WMOs betegnelser for søgang',
  'only as context; FRANK assesses the numeric height.':
    'kun som kontekst; FRANK vurderer den talfastsatte bølgehøjde.',
  'defines significant wave height as the mean height of the highest third of waves and notes that individual waves can be higher. FRANK separately cautions that the number does not describe local surf or short steep chop by itself.':
    'definerer signifikant bølgehøjde som middelhøjden af den højeste tredjedel af bølgerne og bemærker, at enkeltbølger kan være højere. FRANK advarer særskilt om, at tallet ikke i sig selv beskriver lokal brænding eller kort, krap sø.',
  'FRANK calculates the point at 80% and rounds it to the same precision as the forecast. The remaining room is not a guaranteed safety margin; it simply makes shrinking room to your maximum visible.':
    'FRANK beregner punktet ved 80% og afrunder det til samme præcision som prognosen. Den resterende afstand er ikke en garanteret sikkerhedsmargin; reglen gør blot den faldende afstand til dit maksimum synlig.',
  '2. Wind speed and gusts': '2. Vindstyrke og vindstød',
  'MET forecasts a 10-minute mean wind at 10 m and a peak gust averaged over three seconds. FRANK compares mean wind with your selected maximum. If gust checking is on, it also checks a derived gust maximum of {0} times the mean-wind maximum.':
    'MET varsler middelvind over 10 minutter i 10 meters højde og det kraftigste vindstød som et gennemsnit over tre sekunder. FRANK sammenligner middelvinden med dit valgte maksimum. Er kontrol af vindstød slået til, tjekkes de også mod et beregnet maksimum på {0} gange maksimum for middelvind.',
  'Mean wind is below {0} m/s, and any enabled gust check is below its own check point.':
    'Middelvinden er under {0} m/s, og en eventuel kontrol af vindstød ligger under sit eget tjekpunkt.',
  'Mean wind is from {0} through {1} m/s, or an enabled gust check is from its own check point through its maximum.':
    'Middelvinden ligger fra {0} til og med {1} m/s, eller et vindstød, der kontrolleres, ligger fra sit eget tjekpunkt til og med sit maksimum.',
  'Mean wind is above {0} m/s, or an enabled gust check is above its maximum.':
    'Middelvinden er over {0} m/s, eller et vindstød, der kontrolleres, er over sit maksimum.',
  'When mean wind and gusts both reach their check point, FRANK shows only the mean-wind explanation — the two say the same thing. A gust explanation on its own means the gusts are high relative to the mean wind, which is exactly what this check is for.':
    'Når middelvind og vindstød begge når deres tjekpunkt, viser FRANK kun forklaringen om middelvind — de to siger det samme. En forklaring om vindstød alene betyder, at vindstødene er høje i forhold til middelvinden, og det er netop det, dette tjek er til for.',
  "For example, a mean-wind maximum of {0} m/s gives a derived gust maximum of {1} m/s. The factor is FRANK's rule of thumb.":
    'Et maksimum for middelvind på {0} m/s giver for eksempel et beregnet maksimum for vindstød på {1} m/s. Faktoren er FRANKs egen tommelfingerregel.',
  'It stays fixed instead of learning from recent forecasts, so the limit does not move with the weather it is meant to judge.':
    'Den ligger fast og tilpasser sig ikke de seneste prognoser. Grænsen flytter sig derfor ikke med det vejr, den skal vurdere.',
  'Mean-wind names follow': 'Navnene på middelvind følger',
  "DMI's Beaufort scale": 'DMIs Beaufortskala',
  'A gust is shown only as a number because a short gust is not a Beaufort mean-wind category. Measurement definitions:':
    'Et vindstød vises kun som et tal, fordi et kort vindstød ikke er en Beaufort-kategori for middelvind. Definitioner af målingerne:',
  'The DKF/IPP material behind these profiles does not publish separate numeric gust bands. The':
    'DKF/IPP-materialet bag profilerne offentliggør ikke særskilte talgrænser for vindstød.',
  "also treats gusts as relevant in an official kayak forecast. FRANK does not copy that forecast's local Great Lakes thresholds. If you turn gust checking off, the forecast still shows gusts, but they do not affect the verdict.":
    'regner også vindstød som relevante i en officiel kajakprognose. FRANK kopierer ikke prognosens lokale grænser for De Store Søer. Slår du kontrollen af vindstød fra, vises vindstødene stadig i prognosen, men de påvirker ikke vurderingen.',
  'MET does not publish gusts for the longer-range 6- or 12-hour outlook blocks. When that happens, FRANK says the gust is unavailable and judges the outlook only from the readings the block contains.':
    'MET varsler ikke vindstød i langtidsudsigtens blokke på 6 eller 12 timer. Når det sker, oplyser FRANK, at vindstød mangler, og vurderer kun udsigten ud fra blokkens øvrige målinger.',
  '5. Local wind sectors': '5. Lokale vindsektorer',
  'These limits are optional and off by default. If you turn them on, FRANK applies separate wind limits to the fixed sectors below for {0}. A sector limit can make your profile stricter.':
    'Disse grænser er valgfrie og slået fra som standard. Slår du dem til, bruger FRANK særskilte vindgrænser for de faste sektorer nedenfor ved {0}. En sektorgrænse kan gøre din profil strengere.',
  'Maximum {0} m/s for this direction.': 'Maksimum {0} m/s for denne retning.',
  'FRANK estimated these broad area bearings and starting limits. They are not club-published rules or a survey of every shoreline.':
    'FRANK har anslået disse retninger og startgrænser for det større område. De er ikke klubregler og bygger ikke på en kortlægning af hver kyststrækning.',
  'An active sector uses the same automatic check-point rule as the general wind limit.':
    'En aktiv sektor bruger samme regel for automatiske kontrolpunkter som den generelle vindgrænse.',
  'Sector limits use mean wind, not gusts.': 'Sektorgrænserne bruger middelvind, ikke vindstød.',
  'You can adjust the wind limits. The bearings stay fixed.': 'Du kan justere vindgrænserne. Retningerne ligger fast.',
  'Water level comes from a storm-surge forecast model, not an astronomical tide table. The value shown is the forecast water level relative to mean sea level at the nearest model grid point, including wind setup and pressure effects.':
    'Vandstanden kommer fra en stormflodsmodel, ikke en astronomisk tidevandstabel. Den viste værdi er den forudsagte vandstand i forhold til middelvandstand ved nærmeste modelpunkt, inklusive vindstuvning og trykeffekter.',
  'Water level is shown for planning context only. It does not change the safety verdict or filter launch windows.':
    'Vandstanden vises kun som hjælp til planlægningen. Den ændrer ikke sikkerhedsvurderingen og filtrerer ikke rovinduer.',
  '6. Weather conditions (rain, snow, sleet, fog and thunder)': '6. Vejrforhold (regn, sne, slud, tåge og torden)',
  "The weather description follows MET Norway's official":
    'Vejrbeskrivelsen følger MET Norways officielle',
  'Weathericons legend': 'Weathericons-symbolforklaring',
  'Danish wording follows': 'Den danske ordlyd følger',
  'DMI weather terminology': 'DMI-vejrterminologi',
  'FRANK does not infer rain or lightning from other readings. It gives each published weather condition a paddling rating:':
    'FRANK udleder ikke regn eller lyn af andre målinger. Hvert offentliggjort vejrforhold får en vurdering til kajakroning:',
  'clear, fair, partly cloudy, cloudy, and light rain. These conditions do not add a weather flag.':
    'klart vejr, let skyet, delvist skyet, skyet og let regn. Disse forhold giver ikke en vejrbemærkning.',
  'Check before launch:': 'Tjek før du tager på vandet:',
  'rain, fog, light or ordinary snow and sleet, and non-heavy rain showers. Check what they mean for your route and visibility.':
    'regn, tåge, let eller almindelig sne og slud samt ikke-kraftige regnbyger. Tjek, hvad de betyder for din rute og sigtbarheden.',
  'heavy precipitation, snow or sleet showers, and every condition with thunder.':
    'kraftig nedbør, sne- eller sludbyger og alle vejrforhold med torden.',
  'There is no rain limit or lightning setting. Each forecast description keeps its specific meaning, for example "Heavy rain" or "Heavy rain and thunder".':
    'Der er ingen indstilling for regn eller lyn. Hver vejrbeskrivelse beholder sin præcise betydning, for eksempel "Kraftig regn" eller "Kraftig regn med torden".',
  'See all weather ratings ({0} conditions)': 'Se alle vejrvurderinger ({0} forhold)',
  'MET supplies the condition name. FRANK chooses the paddling result shown here. Day, night, and polar-twilight versions of a symbol have the same result.':
    'MET leverer navnet på vejret. FRANK vælger vurderingen til kajakroning, som vises her. Dag-, nat- og polartusmørkeversioner af et symbol får samme resultat.',
  'Published condition': 'Vejrbeskrivelse',
  'FRANK result': 'FRANKs vurdering',
  'Clear sky, fair, partly cloudy, or cloudy': 'Klart vejr, let skyet, delvist skyet eller skyet',
  'Light rain showers or rain showers': 'Lette regnbyger eller regnbyger',
  'Light or ordinary sleet or snow': 'Let eller almindelig slud eller sne',
  'Heavy rain showers or heavy rain': 'Kraftige regnbyger eller kraftig regn',
  'Light, ordinary, or heavy sleet or snow showers': 'Lette, almindelige eller kraftige slud- eller snebyger',
  'Heavy sleet or heavy snow': 'Kraftig slud eller kraftig sne',
  'Any rain, sleet, or snow condition with thunder': 'Alle vejrforhold med regn, slud eller sne og torden',
  'This weather condition alone does not raise the result.': 'Dette vejrforhold hæver ikke i sig selv vurderingen.',
  'Light continuous rain alone does not raise the result.': 'Let vedvarende regn hæver ikke i sig selv vurderingen.',
  'Rain showers trigger Check before launch.': 'Regnbyger udløser Tjek før du tager på vandet.',
  'Continuous rain triggers Check before launch.': 'Vedvarende regn udløser Tjek før du tager på vandet.',
  'Continuous light or ordinary sleet and snow trigger Check before launch.':
    'Vedvarende let eller almindelig slud og sne udløser Tjek før du tager på vandet.',
  'Fog triggers Check before launch because visibility needs checking.':
    'Tåge udløser Tjek før du tager på vandet, fordi sigtbarheden skal kontrolleres.',
  'Heavy precipitation is Not recommended.': 'Kraftig nedbør frarådes.',
  'Every sleet or snow shower is Not recommended, including those MET labels light.':
    'Alle slud- og snebyger frarådes, også når MET kalder dem lette.',
  'Every thunder condition is Not recommended.': 'Alle vejrforhold med torden frarådes.',
  'The numeric precipitation amount does not set the result. The published condition code does. An unknown or missing code becomes Check before launch because FRANK cannot assess it.':
    'Nedbørsmængden som tal afgør ikke vurderingen. Det gør den offentliggjorte vejrkode. En ukendt eller manglende kode giver Tjek før du tager på vandet, fordi FRANK ikke kan vurdere den.',
  'Official DMI and MeteoAlarm warnings are shown separately. They do not silently change this table or the verdict, so always open the warning for its area and timing.':
    'Officielle varsler fra DMI og MeteoAlarm vises særskilt. De ændrer ikke ubemærket tabellen eller vurderingen, så åbn altid varslet for at se område og tidspunkt.',
  'Weather only mode shows these conditions without applying any FRANK verdict rules.':
    'Kun vejr viser disse forhold uden at anvende FRANKs vurderingsregler.',
  'weather': 'vejr',
  'FRANK checks every enabled rule for each hour. The':
    'FRANK kontrollerer hver aktiveret regel for hver time. Det',
  'most restrictive result': 'strengeste resultat',
  'becomes the overall rating. A rule can raise the result (Within limits → Check before launch → Not recommended), but it cannot lower a result set by another rule:':
    'bliver den samlede vurdering. En regel kan hæve resultatet (Inden for grænserne → Tjek før du tager på vandet → Frarådes), men den kan ikke sænke et resultat, som en anden regel har sat:',
  'If any rule says Not recommended, the whole hour is Not recommended, even if every other reading is within its limit.':
    'Hvis én regel siger Frarådes, frarådes hele timen, også selv om alle andre målinger er inden for deres grænser.',
  'A rule that only asks for a check, such as the daylight rule, cannot make an hour Not recommended by itself.':
    'En regel, der kun beder dig tjekke forholdene, som dagslysreglen, kan ikke alene føre til, at timen frarådes.',
  'FRANK lists each separate problem it finds. If the general and local-sector limits flag the same mean wind, only the controlling wind explanation is shown.':
    'FRANK viser hvert særskilt problem, den finder. Hvis den generelle grænse og en lokal sektorgrænse markerer den samme middelvind, vises kun den afgørende vindbegrundelse.',
  '4. Water temperature': '4. Vandtemperatur',
  'Cold water can affect breathing and movement after an unexpected capsize. FRANK uses two temperature boundaries because clothing, rescue time, and paddling plans matter:':
    'Koldt vand kan påvirke vejrtrækning og bevægelighed efter en uventet kæntring. FRANK bruger to temperaturgrænser, fordi beklædning, redningstid og turplan betyder noget:',
  'Within the selected temperature limits. This is not a clothing recommendation.':
    'Inden for de valgte temperaturgrænser. Dette er ikke en anbefaling af beklædning.',
  'Check before launch. Plan clothing and rescue for cold-water immersion.':
    'Tjek før du tager på vandet. Planlæg beklædning og redning med tanke på et uventet ophold i koldt vand.',
  'Not recommended under the selected temperature limits.':
    'Turen frarådes efter de valgte temperaturgrænser.',
  'The default 15°C check follows': 'Standardtjekket ved 15 °C følger',
  'cold-water-shock guidance. The default 10°C boundary follows advice from':
    'vejledning om kuldechok. Standardgrænsen på 10 °C følger rådet fra',
  'to wait until the water is above 10°C.': 'om at vente, til vandet er over 10 °C.',
  '7. Daylight rule': '7. Dagslysregel',
  'Many clubs require navigation lights and permission between sunset and sunrise. When the daylight rule is on, FRANK marks those hours Check before launch. You can turn it off if your own rules allow night paddling. A longer-range outlook block gets the same result unless its whole period is in daylight. Launch windows work differently: FRANK removes periods with no complete daylight hour and shows only the longest continuous daylight part of a partial period.':
    'Mange klubber kræver lanterner og tilladelse mellem solnedgang og solopgang. Når dagslysreglen er slået til, markeres de timer med Tjek før du tager på vandet. Du kan slå reglen fra, hvis dine egne regler tillader natroning. En blok i langtidsudsigten får samme vurdering, medmindre hele perioden ligger i dagslys. Rovinduer fungerer anderledes: FRANK fjerner perioder uden en hel time i dagslys og viser kun den længste sammenhængende del af en delvis periode, der ligger i dagslys.',
  '8. Launch windows': '8. Rovinduer',
  'A launch window is an unbroken green run that stays below every automatic check point and passes every other active check. Periods rated Check before launch remain visible in the forecast, but are not listed as launch windows:':
    'Et rovindue er et ubrudt grønt forløb, som ligger under alle automatiske kontrolpunkter og består alle andre aktive tjek. Perioder med Tjek før du tager på vandet kan stadig ses i prognosen, men vises ikke som rovinduer:',
  'Minimum duration:': 'Minimumsvarighed:',
  'runs shorter than your Min Duration setting are not shown.': 'forløb kortere end din min varighed vises ikke.',
  'Check before launch periods:': 'Perioder, der skal tjekkes:',
  'these stay amber in the full forecast so you can inspect the reason, but they are not promoted into the green launch-window list.':
    'de forbliver gule i hele prognosen, så du kan se årsagen, men de bliver ikke gjort til grønne rovinduer.',
  'Day boundaries:': 'Døgngrænser:',
  'a continuous hourly window can cross local midnight. The calendar draws its pieces on the matching days, and the list names the end day when needed.':
    'et sammenhængende timevindue kan krydse lokal midnat. Kalenderen tegner delene på de rigtige dage, og listen angiver slutdagen, når det er nødvendigt.',
  'Longer range:': 'Længere sigt:',
  'beyond the hourly forecast, coarser outlook blocks (6 hours, occasionally 12) form windows from the readings available in each block. Gusts are not published there. These windows are marked "Outlook"; treat them as planning hints, not commitments.':
    'ud over timeprognosen danner grovere udsigtsblokke (6 timer, af og til 12) vinduer ud fra de målinger, der findes i hver blok. Vindstød varsles ikke her. Vinduerne markeres som "Udsigt"; brug dem som fingerpeg til planlægningen, ikke som løfter.',
  'When no window qualifies, FRANK says how many continuous stretches came close so you can find them on the timeline. It does not list them as windows.':
    'Når intet rovindue opfylder kravene, fortæller FRANK, hvor mange sammenhængende perioder der var tæt på, så du kan finde dem i tidslinjen. De vises ikke som rovinduer.',
  'Close': 'Luk',
  'DMI maintenance may delay wave and water-level forecasts':
    "Vedligehold kan forsinke DMI's prognoser for bølger og vandstand",
  'DMI says maintenance at its supercomputer provider may delay wave and water-level forecasts from 31 August through 10 September. FRANK keeps the latest complete forecast and checks again automatically. Check the forecast age before you launch.':
    "DMI oplyser, at vedligeholdelse hos deres supercomputerleverandør kan forsinke prognoser for bølger og vandstand fra 31. august til og med 10. september. FRANK viser den seneste komplette prognose og tjekker automatisk igen. Tjek prognosens alder, før du tager på vandet.",
  "Read DMI's maintenance notice": "Læs DMI's meddelelse om vedligeholdelse",
};
