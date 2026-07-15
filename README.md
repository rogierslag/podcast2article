# Podcast2Article

Podcast2Article is een open-source Node.js-app die een **publieke Spotify-podcastaflevering** omzet in:

1. een transcript met sprekers en tijdcodes;
2. een helder blogartikel in de herkenbare stijl van de podcast;
3. controleerbare bronlinks van iedere artikelalinea naar het juiste transcript- en audiomoment.

De audio wordt niet uit Spotify gedownload. De app gebruikt de Spotify-link alleen om de aflevering te herkennen en zoekt vervolgens dezelfde aflevering via de openbare Apple Podcasts-index en de oorspronkelijke publieke audiobron.

## Snel starten

Vereisten: Node.js 20+ en een OpenAI API-key. FFmpeg wordt als Node-dependency meegeleverd.

```bash
npm install
OPENAI_API_KEY='jouw-sleutel' npm run dev
```

Open daarna [http://localhost:3000](http://localhost:3000). De sleutel blijft in het proces en wordt niet door de app opgeslagen.

Voor productie:

```bash
npm run build
OPENAI_API_KEY='jouw-sleutel' npm start
```

## Hoe het werkt

```text
Spotify-afleveringslink
  → Spotify oEmbed-metadata
  → overeenkomst zoeken in de publieke Apple Podcasts-index
  → audio van de originele podcasthost downloaden
  → comprimeren en opdelen met FFmpeg
  → gpt-4o-transcribe-diarize (sprekers + tijdcodes)
  → brongebonden artikel via de Responses API
  → artikel met aanklikbare transcriptbronnen
```

Jobs worden lokaal als JSON opgeslagen in `data/jobs/`. Tijdelijke audio wordt na voltooiing of een fout verwijderd. De app heeft bewust geen accountsysteem; zet hem niet zonder authenticatie en rate limiting open op het publieke internet.
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
| `PORT` | `3000` | HTTP-poort |
| `ARTICLE_MODEL` | `gpt-5.6-terra` | Model voor het artikel |
| `TRANSCRIPTION_MODEL` | `gpt-4o-transcribe-diarize` | Transcriptiemodel |
| `MAX_AUDIO_MB` | `500` | Maximale downloadgrootte |
| `AUDIO_CHUNK_SECONDS` | `300` | Lengte van ieder audiofragment (5 minuten; toegestaan: 60–1200) |
| `OPENAI_TRANSCRIPTION_TIMEOUT_MS` | `600000` | Timeout per transcriptiefragment (10 minuten) |
| `OPENAI_ARTICLE_TIMEOUT_MS` | `600000` | Timeout voor artikelgeneratie (10 minuten) |
| `LOG_STACKS` | `false` | Toon volledige foutstacks in de CLI |

De CLI toont per job de bronresolutie, download- en FFmpeg-duur, chunkgroottes,
OpenAI-start- en eindmomenten en iedere 30 seconden een heartbeat zolang een
OpenAI-request nog loopt. API-keys en transcriptinhoud worden niet gelogd.

Als alleen de artikelgeneratie faalt terwijl het transcript al compleet is, kan
de bestaande transcriptie zonder nieuwe audio- of transcriptiekosten worden
hergebruikt:

```bash
curl -X POST http://localhost:3000/api/jobs/<job-id>/retry-article
```

## Beperkingen

- Alleen specifieke publieke `open.spotify.com/episode/...`-links worden geaccepteerd.
- De aflevering moet ook in een openbare podcastindex/RSS-bron staan. Spotify-exclusives werken niet.
- Titels die sterk afwijken tussen Spotify en de RSS-bron kunnen niet automatisch worden gekoppeld; de app kiest bij twijfel bewust geen bron.
- Sprekerlabels kunnen tussen lange audiochunks wisselen. De tekst en tijdcodes blijven wel gekoppeld.
- Transcriptie en herschrijven kunnen fouten bevatten. De tijdcodelinks zijn bedoeld om publicaties eenvoudig te controleren.

## Verantwoord gebruik

Gebruik alleen audio die je rechtmatig mag verwerken. Een publieke feed betekent niet automatisch dat je een volledige transcriptie of afgeleid artikel commercieel mag herpubliceren. Respecteer auteursrecht, portretrecht, privacy, licenties en de voorwaarden van de podcasthost. Vermeld de oorspronkelijke podcast en link ernaar.

## Ontwikkelen

```bash
npm test
npm run check
```

Bijdragen zijn welkom. Zie [LICENSE](./LICENSE) voor de MIT-licentie.
