# Podcast2Article

Podcast2Article is een open-source Node.js-app die een **publieke
Spotify-podcastaflevering, YouTube-video, Fathom- of Google Meet-opname** omzet in:

1. een transcript met sprekers en tijdcodes;
2. een helder blogartikel in de herkenbare stijl van de opname;
3. controleerbare bronlinks van iedere artikelalinea naar het juiste transcript- en audiomoment.

Afgeronde artikelen verschijnen automatisch op de overzichtspagina
[`/articles`](http://localhost:3000/articles), met de nieuwste bovenaan. Daar kun
je artikelen markeren als gelezen; die status wordt lokaal bij de opdracht
opgeslagen en kan ook weer worden teruggedraaid. Opdrachten die nog in de
wachtrij staan of worden verwerkt verschijnen bovenaan met hun actuele stap en
voortgang; dit deel van het overzicht wordt automatisch ververst.

Bronverwijzingen openen een venster bij het artikel, met het betreffende
transcriptfragment en audio vanaf de gekozen tijdcode. Sluiten of Escape pauzeert
de audio en brengt je terug naar dezelfde verwijzing. Gedeelde artikelen tonen
alleen de afspeelbediening; het privétranscript blijft afgeschermd. Links in de
inhoudsopgave bewaren zowel het artikel als de sectie, ook na vernieuwen.

De audio wordt niet uit Spotify gedownload. De app gebruikt de Spotify-link alleen om de aflevering te herkennen en zoekt vervolgens dezelfde aflevering via de openbare Apple Podcasts-index en de oorspronkelijke publieke audiobron.
Van een publieke YouTube-video wordt alleen de beste beschikbare audiostream
opgehaald; afspeellijsten, actieve livestreams en video's waarvoor aanmelding
nodig is worden niet verwerkt.
Google Meet-opnames worden opgehaald via de publieke Google Drive-link. De app
maakt daarvan een compacte lokale audioversie voor betrouwbare weergave en
tijdcodelinks; het oorspronkelijke videobestand wordt na verwerking verwijderd.

Voor een Meet-opname plak je de Drive-link van het opnamebestand, bijvoorbeeld
`https://drive.google.com/file/d/.../view`. Zet in Drive de algemene toegang op
**Iedereen met de link** en zorg dat kijkers het bestand mogen downloaden. Een
`meet.google.com/...`-link naar een vergaderruimte bevat geen opnamebestand en
wordt daarom niet geaccepteerd.

Voor Fathom gebruik je de publieke deellink `https://fathom.video/share/...`.
Kopieer deze via **Share** en kies **Anyone with the link**. Interne
`fathom.video/calls/...`-links vereisen aanmelding en worden niet geaccepteerd.
De app gebruikt yt-dlp om de opname op te halen en maakt daarna hetzelfde lokale
audio- en transcriptbestand als bij Drive. De bestaande Fathom-samenvatting en
transcriptie worden niet geïmporteerd. Er is geen Fathom API-key nodig; cookies,
privé-opnames en teamgebonden toegang worden niet ondersteund. De download valt
onder `MAX_RECORDING_MB` en `MEDIA_DOWNLOAD_TIMEOUT_MS`.

## Ontwerp

De [merkrichtlijnen](docs/BRAND.md) beschrijven de visuele identiteit, typografie,
kleuren, interacties en het bedoelde gebruik van afgeronde hoeken. Gebruik deze
samen met [AGENTS.md](AGENTS.md) bij wijzigingen aan de interface.

## Snel starten

Vereisten: Node.js 24+, Python 3.11+ en een OpenAI API-key.
FFmpeg en yt-dlp worden als Node-dependencies meegeleverd. Python wordt door
yt-dlp gebruikt op macOS en Linux. PDF's worden rechtstreeks in Node.js
opgebouwd; daarvoor is geen browser op de server nodig.

Met `FFMPEG_BIN` kun je een absoluut pad naar een apart geïnstalleerde FFmpeg
instellen; zonder die variabele gebruikt de app de meegeleverde binary. De
productie-installer installeert op Linux x64 een vastgelegde FFmpeg/ffprobe-build
met SHA-256-controle. Een bestaande `90-ffmpeg-override.conf` blijft behouden;
een andere versie activeren is een expliciete, terug te draaien beheeractie.
Iedere nieuwe release doorloopt vóór activering een echte mediatest. Zie het
[beheer- en rollback-draaiboek](docs/FFMPEG.md) en het
[incidentverslag](docs/incidents/2026-08-28-fathom-ffmpeg.md).

```bash
npm install
OPENAI_API_KEY='jouw-sleutel' npm run dev
```

Open daarna [http://localhost:3000](http://localhost:3000). De sleutel blijft in het proces en wordt niet door de app opgeslagen.

Voor productie:

```bash
cp .env.example .env
# Vul OPENAI_API_KEY in binnen .env.
yarn build
yarn start
```

Zet voor een publieke installatie de gebruikersaccounts als JSON in `.env`.
Ieder wachtwoord moet minimaal 16 tekens lang zijn. De login gebruikt een
ondertekende, 30 dagen geldige `HttpOnly`-cookie die automatisch ongeldig wordt
als de accountconfiguratie verandert:

```bash
APP_USERS='{"rogier":"een-lang-uniek-wachtwoord","melvin":"nog-een-uniek-wachtwoord"}'
```

Als `APP_USERS` leeg blijft, is authenticatie uitgeschakeld voor lokaal
ontwikkelen. Zet de productie-installatie altijd achter HTTPS; bijvoorbeeld via
Caddy of Nginx. Na vijf mislukte pogingen vanaf hetzelfde IP-adres blokkeert de
login nieuwe pogingen gedurende vijftien minuten.

Gebruik voor regionale OpenAI-verwerking in de EU of de VS respectievelijk
`OPENAI_REGION=eu` of `OPENAI_REGION=us` in `.env`. `yarn start` leest de
variabelen uit dat bestand:

```bash
OPENAI_REGION=eu
```

## Hoe het werkt

```text
Spotify-afleveringslink       YouTube-videolink        publieke Drive-opnamelink
  → Spotify + Apple/RSS         → yt-dlp-metadata        → Drive-bestandsmetadata
  └─────────────────────────────┴────────────────────────┘
Fathom-deellink → yt-dlp-metadata → audio of video downloaden
  → compacte afspeelaudio maken en tijdelijk videobeeld verwijderen
  → comprimeren en opdelen met FFmpeg
  → gpt-4o-transcribe-diarize (sprekers + tijdcodes)
  → brongebonden artikel via de Responses API
  → artikel met aanklikbare transcriptbronnen
```

Jobs worden per gebruiker als JSON opgeslagen in
`data/users/<gebruikersnaam>/jobs/`. Compacte afspeelaudio wordt opgeslagen in
`data/users/<gebruikersnaam>/media/`; gedownloade bronbestanden en
transcriptiechunks worden verwijderd. Gebruikers kunnen uitsluitend hun eigen
jobs, artikelen, transcripties en audio benaderen.
Onvoltooide jobs worden na een serverherstart automatisch opnieuw gestart met
hetzelfde job-ID. Maximaal drie jobs worden tegelijk verwerkt. Downloads en
FFmpeg blijven één voor één draaien; transcriptie en artikelgeneratie kunnen
overlappen met andere jobs. Broninformatie wordt apart opgehaald (maximaal drie
verzoeken tegelijk), zodat titels en afbeeldingen al in de wachtrij verschijnen.
De actieve verwerkingsstap begint na een herstart opnieuw,
zodat er nooit stilzwijgend een job in een oude status blijft hangen.

Elke nieuwe job bewaart API-gebruik in `apiUsage` in hetzelfde JSON-bestand.
Per transcriptiechunk en artikelverzoek worden model, aangevraagde en gemelde
service tier, request-ID, tijdsduur, gebruikscijfers en pogingen opgeslagen.
Automatische retries krijgen elk een eigen record. Ook bij afgekeurde
artikelinhoud blijft het gebruik van het geslaagde API-verzoek bewaard.

`knownEstimatedCostUsd` telt de bekende USD-schattingen op;
`unknownCostRequests` telt pogingen waarvan de kosten onbekend zijn.
Een ontbrekend bedrag is `null`, geen nul. De schattingen gebruiken opgeslagen
prijzen van 15 september 2026: voor `gpt-4o-transcribe-diarize` de gemelde
audioduur, voor `gpt-5.6-terra` de tokens, cacheverdeling, contextlengte, gemelde
service tier en eventuele regionale toeslag. Andere modellen en aangepaste
API-endpoints bewaren wel gebruik, maar krijgen geen geschatte prijs.
Prijzen staan in `src/services/api-usage.ts`; elke schatting bewaart de gebruikte
prijzen en bron zodat oude bedragen niet veranderen bij een prijsupdate.

Dit zijn API-kostenschattingen, geen factuurbedragen. Hosting, downloads en
FFmpeg-kosten zijn niet inbegrepen. Oude jobs worden niet achteraf als gratis
beschouwd: ontbrekende `apiUsage` betekent onbekend; bij een nieuwe poging op
zo'n job staat `coverage` op `partial`. Na een harde stop kan een poging
`pending` blijven, met onbekende kosten. Gebruiksgegevens zijn uitsluitend
beschikbaar bij de eigen job, niet via publieke links of opgeslagen kopieën.

Bij `SIGINT` of `SIGTERM` stopt de server met het aannemen van verzoeken en
annuleert hij alle actieve OpenAI HTTP-requests via `AbortSignal`. Onderbroken
jobs worden als hervatbaar opgeslagen, tijdelijke audio wordt opgeruimd en het
proces wacht maximaal 15 seconden op een nette afsluiting. Let op: het sluiten
van het HTTP-request is de beschikbare client-side annulering; de API biedt
voor transcriptieverzoeken geen afzonderlijk server-side cancel-endpoint.

## Configuratie

### Taal van de interface

De interface volgt de primaire browsertaal: Nederlands (`nl`, `nl-NL`, `nl-BE`,
enzovoort) gebruikt Nederlandse tekst; alle andere talen vallen terug op Engels.
Dit geldt ook voor foutmeldingen, datums en de vaste labels in PDF-exports.
De taalkeuze voor het genereren van artikelen blijft hiervan onafhankelijk.
Artikelen en transcripties worden niet opnieuw vertaald wanneer de interfacetaal verandert.

De gedeelde vertalingen staan in `public/i18n.js`, met semantische sleutels zoals
`article.delete` en `nav.articles` in plaats van Nederlandse tekst als sleutel.
De tests controleren automatisch alle HTML-templates en browsermodules op ontbrekende
vertalingen, inclusief toegankelijkheidslabels en enkelvoud/meervoud.
De server gebruikt
`Accept-Language` voor de eerste HTML-weergave; browserverzoeken sturen de gekozen
interfacetaal mee. Vernieuw de pagina na een wijziging van de browsertaal.

| Variabele                         | Standaard                   | Betekenis                                                                                                |
| --------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                  | vereist                     | Via de CLI meegegeven OpenAI API-key                                                                     |
| `APP_USERS`                       | leeg                        | JSON-object met gebruikersnaam/wachtwoord-paren; leeg schakelt authenticatie uit                         |
| `OPENAI_REGION`                   | `global`                    | OpenAI API-regio: `global`, `eu` (EER + Zwitserland) of `us`                                             |
| `HOST`                            | `127.0.0.1`                 | Netwerkinterface; gebruik alleen in een container eventueel `0.0.0.0`                                    |
| `PORT`                            | `3000`                      | HTTP-poort                                                                                               |
| `ARTICLE_MODEL`                   | `gpt-5.6-terra`             | Model voor het artikel                                                                                   |
| `TRANSCRIPTION_MODEL`             | `gpt-4o-transcribe-diarize` | Transcriptiemodel                                                                                        |
| `MAX_AUDIO_MB`                    | `500`                       | Maximale Spotify-audiodownload                                                                           |
| `MAX_YOUTUBE_MB`                  | `500`                       | Maximale YouTube-audiodownload                                                                           |
| `MAX_RECORDING_MB`                | `1500`                      | Maximale Google Drive- of Fathom-opnamedownload                                                          |
| `YOUTUBE_METADATA_TIMEOUT_MS`     | `60000`                     | Timeout voor het lezen van YouTube-metadata (1 minuut)                                                   |
| `MEDIA_DOWNLOAD_TIMEOUT_MS`       | `900000`                    | Timeout voor het downloaden van media (15 minuten)                                                       |
| `FFMPEG_BIN`                      | meegeleverde binary         | Absoluut pad naar een alternatief FFmpeg-executable voor normalisatie, splitsen en Fathom-postprocessing |
| `AUDIO_CHUNK_SECONDS`             | `300`                       | Lengte van ieder audiofragment (5 minuten; toegestaan: 60–1200)                                          |
| `OPENAI_TRANSCRIPTION_TIMEOUT_MS` | `600000`                    | Timeout per transcriptiefragment (10 minuten)                                                            |
| `OPENAI_ARTICLE_TIMEOUT_MS`       | `600000`                    | Timeout voor artikelgeneratie (10 minuten)                                                               |
| `LOG_STACKS`                      | `false`                     | Toon volledige foutstacks in de CLI                                                                      |

De CLI toont per job de bronresolutie, download- en FFmpeg-duur, chunkgroottes,
OpenAI-start- en eindmomenten en iedere 30 seconden een heartbeat zolang een
OpenAI-request nog loopt. API-keys en transcriptinhoud worden niet gelogd.

`OPENAI_REGION` selecteert het OpenAI API-endpoint voor zowel transcriptie als
artikelgeneratie. Regionale dataresidentie moet daarnaast voor het gebruikte
OpenAI-project zijn ingericht en is afhankelijk van de gekozen modellen en
features.

Als alleen de artikelgeneratie faalt terwijl het transcript al compleet is, kan
de bestaande transcriptie zonder nieuwe audio- of transcriptiekosten worden
hergebruikt:

```bash
curl -X POST http://localhost:3000/api/jobs/<job-id>/retry-article
```

De lengtekeuze toont de beoogde woordenaantallen: compact (700–1.000),
standaard (1.100–1.700) en uitgebreid (1.800–2.600). Dit zijn richtlijnen voor
de generatie, geen gegarandeerde aantallen. Dezelfde bron kan in een andere
taal of lengte opnieuw worden verwerkt. Alleen een bestaande of lopende
opdracht met dezelfde bron, taalkeuze en lengte geldt als duplicaat.
Automatische taalherkenning blijft een aparte keuze naast een expliciete taal.

## Beperkingen

- Publieke `open.spotify.com/episode/...`-links, YouTube-video-, Shorts- en
  afgeronde livestreamlinks, publieke Fathom-deellinks, en Google Drive-links naar één publiek audio- of
  videobestand worden geaccepteerd.
- De aflevering moet ook in een openbare podcastindex/RSS-bron staan. Spotify-exclusives werken niet.
- Titels die sterk afwijken tussen Spotify en de RSS-bron kunnen niet automatisch worden gekoppeld; de app kiest bij twijfel bewust geen bron.
- YouTube-afspeellijsten, actieve of geplande livestreams, privévideo's en
  video's waarvoor aanmelding nodig is worden niet ondersteund.
- Een Drive-opname moet toegankelijk zijn voor iedereen met de link en
  downloadrechten hebben. Door Workspace-beleid afgeschermde opnames werken
  zonder Google-authenticatie bewust niet.
- Meet-ruimte-, Drive-map- en Google Calendar-links bevatten niet rechtstreeks
  het opnamebestand en werken daarom niet.
- Sprekerlabels kunnen tussen lange audiochunks wisselen. De tekst en tijdcodes blijven wel gekoppeld.
- Transcriptie en herschrijven kunnen fouten bevatten. De tijdcodelinks zijn bedoeld om publicaties eenvoudig te controleren.

## Verantwoord gebruik

Gebruik alleen opnames die je rechtmatig mag verwerken. Een publieke link
betekent niet automatisch dat je een volledige transcriptie of afgeleid artikel
commercieel mag herpubliceren. Respecteer auteursrecht, portretrecht, privacy,
licenties en de voorwaarden van de bron. Vermeld en link de oorspronkelijke
opname.

## Ontwikkelen

GitHub Actions voert bij iedere pull request en push naar `main` automatisch
de formatteringscontrole, ESLint, de TypeScript-build en alle tests uit. Deze
controles draaien als zes onafhankelijke jobs, zodat een fout in één controle
de andere resultaten niet tegenhoudt. De buildjob controleert ook de syntaxis
van de browsercode. De workflow kan handmatig worden
gestart via **Actions → Tests → Run workflow**. Hij gebruikt de Node.js-versie
uit `.nvmrc` en installeert dependencies met het bestaande `yarn.lock`.

De workflow gebruikt een standaard Linux-runner. Dat is
[gratis voor publieke repositories](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Er zijn geen repository secrets of betaalde API-aanroepen nodig voor deze checks.
Een run stopt na maximaal 15 minuten; een nieuwe run op dezelfde branch of pull
request annuleert de vorige run.

```bash
npm test
npm run check
npx playwright install chromium webkit
npm run test:browser
npm run check:media
```

De browserjob test desktop-Chromium en mobiele WebKit. Hij bewaart het HTML-rapport,
screenshots en fouttraces gedurende 14 dagen als Actions-artifact. De mediajob
verwerkt een synthetische opname met Ubuntu’s FFmpeg via een expliciete
`FFMPEG_BIN`-instelling. Browser- en mediatests staan apart van `npm run check`,
zodat bestaande productiechecks geen browsers hoeven te installeren.

### Testbeperkingen

- Bekende bugs draaien met Playwrights `test.fail` en worden apart vermeld in het
  Actions-rapport. Een groene workflow betekent niet dat deze bugs zijn opgelost.
  Zodra zo’n test slaagt, faalt de suite totdat de annotatie is verwijderd.
- Mobiele WebKit vervangt geen fysieke iPhone. Native deelmenu’s, focuszoom,
  statusbalktikken en Home Screen-modus vragen nog controle op een toestel.
- Browsertests blokkeren externe verzoeken, gebruiken fallbackfonts en bootsen
  sommige API-antwoorden na. Ze controleren geen pixels tegen eerdere screenshots.
  Servertests controleren de echte API- en opslaggrenzen apart.
- De mediajob controleert de conversieketen met Ubuntu’s FFmpeg, niet met het
  exacte productie-executable of iedere codec. De download in
  `deploy/ffmpeg-release.json` was bij controle onbereikbaar (HTTP 404); herstel
  daarvan en verificatie van de productiebinary blijven apart nodig.
- Offline tests verifiëren geen beschikbaarheid of kwaliteit van externe modellen.
  Een groene workflow bevestigt ook geen productiedeployment; zie
  [de operationele controles](docs/OPERATIONS.md).

Bijdragen zijn welkom. Zie [LICENSE](./LICENSE) voor de MIT-licentie.

### Podcastseries volgen

Via **Series** kun je een Spotify-serielink of openbare RSS-feed toevoegen.
Controleer de gevonden serie en kies de laatste aflevering, de laatste tien,
of alleen nieuwe afleveringen. Het scherm toont
voor bevestiging hoeveel afleveringen je inhaalt. Elke nieuwe verwerking gebruikt
de ingestelde betaalde transcriptie- en artikelmodellen.

De server controleert actieve series bij het starten en daarna elk uur. Hij moet
hiervoor blijven draaien; dit vereist geen externe cronjob. De bestaande wachtrij
verwerkt één opname tegelijk. Via **Pauzeer** stop je nieuwe controles; opdrachten
die al in de verwerkingswachtrij staan worden nog afgerond. **Hervat** haalt ook
sinds de pauze gemiste afleveringen op, voor zover die nog in de feed staan.

Series, overgeslagen afleveringen en nog in te plannen afleveringen staan per
gebruiker in `data/users/<username>/subscriptions.json`. Deze status wordt atomair
opgeslagen en overleeft een herstart. Afleveringen worden herkend aan feed-URL en
RSS-GUID (of audiolink als de GUID ontbreekt). Een reeds bekende audiolink wordt
ook overgeslagen. Mislukte opdrachten worden getoond bij de serie en niet elk uur
opnieuw gestart. Een mislukte feedcontrole wordt wel automatisch opnieuw geprobeerd.
Zonder `OPENAI_API_KEY` wordt niets nieuws ingepland.

Vanuit een podcastartikel kun je bovenaan en onderaan **Volg deze podcast** kiezen.
De bestaande bevestigingspagina opent met standaard alleen nieuwe afleveringen;
eerdere afleveringen ophalen blijft een eigen keuze. Als je de serie al volgt,
zie je dat direct, inclusief een eventuele pauze, met een link naar seriebeheer.
Voor oudere Spotify-artikelen wordt de feed teruggezocht via de opgeslagen
audiolink. Als die niet meer in de openbare index staat, kan de volgstatus niet
worden bepaald.

Spotify wordt gebruikt om de serie te vinden. Bij meerdere zoekresultaten kies
je zelf de juiste openbare feed. Alleen audioafleveringen in RSS 2.0 worden
ondersteund; Spotify-exclusives, betaalde feeds en verdwenen archiefafleveringen
zonder openbare audiobron kunnen niet worden opgehaald. Feeds worden met dezelfde
publieke-netwerkcontrole als andere bronnen opgehaald, met een limiet van 10 MB;
DTD's en externe XML-entiteiten worden geweigerd.

Per inhaalactie worden maximaal tien afleveringen ingepland. Bij tien ongelezen
of nog te verwerken afleveringen pauzeert de serie automatisch. Gelezen,
verwijderde en mislukte opdrachten tellen niet mee. Na lezen hervat je zelf;
ook hervatten respecteert de grens. Reeds ingeplande opdrachten worden niet
geannuleerd. Overgeslagen eerdere afleveringen kun je later per maximaal tien
inhalen, voor zover de openbare feed ze nog aanbiedt en er ruimte is. Deze actie
verandert een handmatige pauze niet.
