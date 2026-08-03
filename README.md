# Podcast2Article

Podcast2Article is een open-source Node.js-app die een **publieke
Spotify-podcastaflevering, YouTube-video of Google Meet-opname** omzet in:

1. een transcript met sprekers en tijdcodes;
2. een helder blogartikel in de herkenbare stijl van de opname;
3. controleerbare bronlinks van iedere artikelalinea naar het juiste transcript- en audiomoment.

Afgeronde artikelen verschijnen automatisch op de overzichtspagina
[`/articles`](http://localhost:3000/articles), met de nieuwste bovenaan.

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

## Snel starten

Vereisten: Node.js 22+, Python 3.9+ en een OpenAI API-key. FFmpeg en yt-dlp
worden als Node-dependencies meegeleverd. Python wordt door yt-dlp gebruikt op
macOS en Linux.

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
                                → audio of video downloaden
  → compacte afspeelaudio maken en tijdelijk videobeeld verwijderen
  → comprimeren en opdelen met FFmpeg
  → gpt-4o-transcribe-diarize (sprekers + tijdcodes)
  → brongebonden artikel via de Responses API
  → artikel met aanklikbare transcriptbronnen
```

Jobs worden lokaal als JSON opgeslagen in `data/jobs/`. Compacte afspeelaudio
wordt opgeslagen in `data/media/`; gedownloade bronbestanden en
transcriptiechunks worden verwijderd. De app heeft bewust geen accountsysteem;
zet hem niet zonder authenticatie en rate limiting open op het publieke internet.
Onvoltooide jobs worden na een serverherstart automatisch opnieuw gestart met
hetzelfde job-ID. De actieve verwerkingsstap begint daarbij opnieuw, zodat er
nooit stilzwijgend een job in een oude status blijft hangen.

Bij `SIGINT` of `SIGTERM` stopt de server met het aannemen van verzoeken en
annuleert hij alle actieve OpenAI HTTP-requests via `AbortSignal`. Onderbroken
jobs worden als hervatbaar opgeslagen, tijdelijke audio wordt opgeruimd en het
proces wacht maximaal 15 seconden op een nette afsluiting. Let op: het sluiten
van het HTTP-request is de beschikbare client-side annulering; de API biedt
voor transcriptieverzoeken geen afzonderlijk server-side cancel-endpoint.

## Configuratie

| Variabele | Standaard | Betekenis |
|---|---|---|
| `OPENAI_API_KEY` | vereist | Via de CLI meegegeven OpenAI API-key |
| `OPENAI_REGION` | `global` | OpenAI API-regio: `global`, `eu` (EER + Zwitserland) of `us` |
| `PORT` | `3000` | HTTP-poort |
| `ARTICLE_MODEL` | `gpt-5.6-terra` | Model voor het artikel |
| `TRANSCRIPTION_MODEL` | `gpt-4o-transcribe-diarize` | Transcriptiemodel |
| `MAX_AUDIO_MB` | `500` | Maximale Spotify-audiodownload |
| `MAX_YOUTUBE_MB` | `500` | Maximale YouTube-audiodownload |
| `MAX_RECORDING_MB` | `1500` | Maximale Google Drive-opnamedownload |
| `YOUTUBE_METADATA_TIMEOUT_MS` | `60000` | Timeout voor het lezen van YouTube-metadata (1 minuut) |
| `MEDIA_DOWNLOAD_TIMEOUT_MS` | `900000` | Timeout voor het downloaden van media (15 minuten) |
| `AUDIO_CHUNK_SECONDS` | `300` | Lengte van ieder audiofragment (5 minuten; toegestaan: 60–1200) |
| `OPENAI_TRANSCRIPTION_TIMEOUT_MS` | `600000` | Timeout per transcriptiefragment (10 minuten) |
| `OPENAI_ARTICLE_TIMEOUT_MS` | `600000` | Timeout voor artikelgeneratie (10 minuten) |
| `LOG_STACKS` | `false` | Toon volledige foutstacks in de CLI |

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

## Beperkingen

- Publieke `open.spotify.com/episode/...`-links, YouTube-video-, Shorts- en
  afgeronde livestreamlinks, en Google Drive-links naar één publiek audio- of
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

```bash
npm test
npm run check
```

Bijdragen zijn welkom. Zie [LICENSE](./LICENSE) voor de MIT-licentie.
