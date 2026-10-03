# Plan dekoningtegelwerken.nl

Status: **fase A goedgekeurd op 3 oktober 2026; fase B = stap 1 (frontend) in uitvoering**
op branch `feature/fase-1-frontend`. De volledige briefing staat in
[`docs/opdrachten/dekoning-website.md`](opdrachten/dekoning-website.md); waar dit plan naar
een briefingsectie verwijst, staat dat als §-nummer.

## Besluiten van Bob (3 oktober 2026)

Deze besluiten gaan vóór wat verderop in dit plan als voorstel of open vraag staat.

| Onderwerp | Besluit |
|---|---|
| Google Reviews | Handmatig gekozen **echte** reviews met link naar Google. **Geen** review-structured data (`Review`/`AggregateRating`). Geen Places API. |
| Btw | Een instelling, standaard **21 %**. |
| AVG | Bewaartermijn **12 maanden** voor aanvragen zonder opdracht. Een korte privacymelding staat al **bij de plattegrond-upload** (stap 3 van de wizard), niet pas bij de checkbox in stap 6. |
| PDF | **Eigen kleine PDF-generator** (dependency-vrij) plus een printweergave. Geen Chromium. |
| Afbeeldingen | Voorlopig **alleen WebP** (via `cwebp`); geen AVIF, `avifenc` wordt niet geïnstalleerd. |
| Beheer | Op het subdomein **`beheer.dekoningtegelwerken.nl`**, inloggen met **wachtwoord + TOTP** (TOTP direct in stap 4, niet als vervolgstap). |
| Offerte versturen | Via een **klantpagina met akkoordknop**; de **PDF gaat als bijlage** mee in de mail. Akkoord op de klantpagina levert `quote_accepted` op. |
| `lead_completed` | Het dossier is **compleet**: foto's en oppervlak zijn bekend. Wordt automatisch bepaald zodra beide aanwezig zijn (bij indienen of later in het beheer). |
| `appointment_requested` | De klant vraagt via de **klantpagina** (van de offerte) een inmeetafspraak aan. |
| Preview | `preview.dekoningtegelwerken.nl`, root `/var/www/preview.dekoningtegelwerken`, met `noindex`-header en basic auth; voorbeeld-vhost en deploy-script in `deploy/`. |
| Branches | Werk per fase op een featurebranch, pushen naar `origin`, nooit naar `main` pushen of mergen; Bob merget. |
| Sfeerbeelden (3 okt 2026, na fase B) | "Overal mooie foto's": de placeholdervlakken worden vervangen door **AI-gegenereerde sfeerbeelden** via KIE.AI (`service/cli/kie-beelden.mjs`, manifest `data/beelden.json`). Voorwaarden: elk beeld staat als `"soort": "sfeerbeeld"` in het manifest, de alt-tekst begint met "Sfeerbeeld", projectbeelden dragen zichtbaar het label "Sfeerbeeld", voorbeeldprojecten houden placeholdernamen (geen verzonnen klanten, plaatsen of cases). **Vóór livegang worden alle sfeerbeelden vervangen door echte projectfoto's van De Koning, of blijven ze alleen staan waar ze niet als eigen werk worden gepresenteerd** (bijv. als algemeen sfeerbeeld bij een dienst). Dit vervangt voor beelden de eerdere regel "geen stock- of AI-beeld" uit §1.11; stockfoto's blijven uitgesloten. |

Uitgangspunt is het bestaande Handsfree Digital-patroon uit `handsfree-digital-werk`:

- statische frontend, **geen build-step, geen frameworks, geen npm-dependencies**;
- dependency-vrije **Node 22-diensten** (`node:http`, `node:sqlite`, ingebouwde `fetch`) op
  127.0.0.1 achter nginx;
- **secrets alleen in `/etc/...env`**, nooit in de repo;
- **eerst opslaan, dan melden**: een aanvraag gaat nooit verloren als mail, Telegram of een
  webhook plat ligt;
- foto- en plattegrondanalyse via de Anthropic API, met een eerlijke terugval naar handmatig
  invullen.

---

## 1. Stack en architectuur

### 1.1 Wat er hergebruikt wordt uit handsfree-digital-werk

| Bron | Wat we overnemen | Aanpassing |
|---|---|---|
| `service/contact.mjs` | Opbouw van de dienst: body-limiet, herkomst-allowlist, honeypot, minimale invultijd, rate limit per IP (pas tellen bij echte verzending), daglimiet in de database, `probeer()`-patroon voor kanalen, Postmark- en Telegram-aanroep, logregels zonder inhoud | Wordt de aanvraagdienst; met uploads, een dossiermodel en webhook-events erbij |
| `service/foto-analyse.mjs` | `PLATTEGROND_PROFIEL` (instructie + JSON-schema), `normaliseerPlattegrond()` (een afgeleide maat scoort nooit "hoog", een ruimte zonder maat krijgt `zekerheid: geen`, buitenmaat als kruiscontrole), het profiel `tegelzetter` (wand/vloer per foto), controle op magic bytes, dagteller | Plattegrond ook als **PDF** (Anthropic `document`-blok); beelden komen uit de opgeslagen upload in plaats van uit de request |
| `assets/demo/calculator-demo.js` | Idee van één **pure rekenmodule** die client én server delen; minimumbedrag, korting, handmatige totaalprijs met reden, afronden | Het prijsmodel wordt **per m² / per strekkende meter / per stuk** (zoals een tegelzetter rekent) in plaats van uren × uurloon, met configureerbare toeslagen en snijverlies |
| `assets/demo/foto-hulp.js` | `verkleinFoto()`: client-side verkleinen naar JPEG (haalt meteen EXIF/GPS weg), base64-pad | Upload gaat naar opslag in plaats van alleen naar analyse |
| `assets/demo/ui-hulp.js` | Eenheden voluit ("24 vierkante meter"), min/plus-teller, keuzepaneel met focus-trap en Escape | Overnemen voor wizard en beheer |
| `systeem/demo/beheer/` | Dossieropbouw, statusbalk op mobiel / kolommen op desktop, offertevoorbeeld met "Opslaan als PDF" via `window.print`, versies met alleen-lezen oude versie, PDOK-adreszoeker | Wordt een echt beheer met database; minder statussen (zie §1.6) |
| Praktijkvoorbeelden via SSI | Gegenereerde fragmenten buiten de git-werkkopie, door nginx ingevoegd | Zelfde aanpak voor de projecten (zie §1.7) |

Kopiëren in plaats van importeren: de twee repo's worden los van elkaar gedeployed. Elk
overgenomen bestand krijgt bovenin een regel `// Overgenomen uit handsfree-digital-werk/<pad>`
zodat verschillen later terug te vinden zijn.

### 1.2 Mappenstructuur

```
dekoning-tegelwerken/
├── index.html                    homepage (hero, projectgrid, specialismen, details,
│                                 voor/na, werkwijze, reviews, over, CTA)
├── offerte/index.html            wizard, 6 stappen (+ bedankscherm in dezelfde pagina)
├── projecten/index.html          volledig projectoverzicht met filters
├── projecten/_sjabloon.html      sjabloon voor gegenereerde projectpagina's (niet publiek)
├── tegelzetter/ badkamer-tegelen/ vloer-betegelen/ toilet-betegelen/
│   grootformaat-tegels/ xxl-tegels/ visgraat-tegels/ natuursteen/
│                                 dienstpagina's, elk een index.html
├── werkwijze/ over-ons/ contact/ privacy/ algemene-voorwaarden/
├── beheer/                       statische beheer-frontend (alleen achter login bruikbaar)
│   ├── index.html  beheer.js  beheer.css
├── css/
│   ├── basis.css                 design tokens (kleuren, typografie, ruimte), reset, utilities
│   ├── site.css                  componenten van de publieke site
│   └── wizard.css
├── js/
│   ├── site.js                   header, menu, reveals, filters, voor/na-slider (element-geguard)
│   ├── wizard.js                 stappenlogica, toestand, uploads, fallbacks
│   └── gedeeld/
│       ├── calculatie.js         pure rekenmodule, ook door de server geïmporteerd
│       ├── foto-hulp.js          verkleinen + upload
│       └── ui-hulp.js
├── data/
│   ├── site.json                 bedrijfsgegevens en vertrouwenselementen (placeholders, zie §3)
│   ├── wizard.json               ruimtes → vervolgvragen (progressive disclosure), géén prijzen
│   └── projecten.voorbeeld.json  vorm van de projectdata voor stap 1 (alleen placeholders)
├── assets/
│   ├── fonts/                    zelf gehost (woff2), geen Google Fonts-verzoek
│   ├── iconen/                   inline-bare SVG's (WhatsApp, pijlen, sterren)
│   └── placeholder/              neutrale placeholdervlakken, duidelijk herkenbaar
├── service/
│   ├── aanvraag.mjs              publieke dienst (zie §1.3)
│   ├── beheer.mjs                beheerdienst (zie §1.3)
│   ├── lib/
│   │   ├── db.mjs                schema, migraties (PRAGMA user_version), prepared statements
│   │   ├── beveiliging.mjs       herkomst, rate limit, honeypot, magic bytes, body-limiet
│   │   ├── mail.mjs              Postmark + sjablonen (bevestiging klant, melding De Koning)
│   │   ├── webhooks.mjs          outbox schrijven + bezorger met HMAC-handtekening en retries
│   │   ├── analyse.mjs           Anthropic-aanroepen (plattegrond, foto-samenvatting)
│   │   ├── generator.mjs         projectpagina's, grid-fragment, sitemap genereren
│   │   └── pdf.mjs               (stap 4, zie open vraag 7)
│   └── cli/
│       ├── gebruiker.mjs         beheeraccount aanmaken / wachtwoord zetten
│       └── aanvragen.mjs         laatste aanvragen bekijken (zoals in handsfree-digital-werk)
├── test/                         node --test (ingebouwd), o.a. calculatie en normalisatie
├── deploy/                       VOORBEELDEN voor Bob: nginx-vhost, systemd-units, env-sjabloon
│                                 (zonder waarden). Worden niet door de code gelezen.
├── docs/
│   ├── PLAN.md
│   └── opdrachten/dekoning-website.md
├── CLAUDE.md                     projectconventies (aan te maken in stap 1)
└── .gitignore
```

> **Zo is het in stap 1 gebouwd** (wijkt op een paar punten af van de schets hierboven):
> één stylesheet `css/site.css` in plaats van `basis.css`/`site.css`/`wizard.css` (één
> verzoek); sjablonen in `_sjablonen/` (header, footer, werkwijze, eindsectie, project,
> dienst) in plaats van `projecten/_sjabloon.html`; projectdata in `data/projecten.json`;
> dienstteksten in `data/diensten.json`; de generator `service/cli/genereer.mjs` houdt ook
> header, footer en head in alle pagina's gelijk. Werkwijze en Over ons zijn in stap 1
> secties op de homepage (`/#werkwijze`, `/#over`), nog geen eigen pagina's. Zie
> `CLAUDE.md` en `docs/GEHEUGEN.md`.

Navigatie (§2): Home, Diensten (uitklap: de zes specialismen + "Tegelzetter"), Projecten,
Werkwijze, Over ons, Contact, plus de knop "Offerte aanvragen". Werkwijze en Over ons zijn
zowel een homepagesectie als een korte eigen pagina, zodat de navigatie ook vanaf
subpagina's werkt en elke pagina een eigen titel/omschrijving heeft.

### 1.3 Node-diensten

Twee processen in plaats van vier. Webhooks, calculatie en generatie zijn modules, geen
losse diensten: minder units en poorten voor Bob, en het publieke aanvalsoppervlak blijft
gescheiden van alles wat achter een login zit.

| Dienst | Poort | Unit (voorstel) | Routes via nginx | Doet |
|---|---|---|---|---|
| `service/aanvraag.mjs` | 127.0.0.1:**8130** | `dekoning-aanvraag` | `/api/aanvraag/*` | Wizardsessie starten, uploads ontvangen, plattegrond laten analyseren, aanvraag indienen → dossier, bevestigingsmail, melding aan De Koning, events `new_lead` en `floorplan_uploaded` in de outbox |
| `service/beheer.mjs` | 127.0.0.1:**8131** | `dekoning-beheer` | `/api/beheer/*`, beschermde bestanden via `X-Accel-Redirect` | Inloggen, dossiers, statussen, notities, calculatieregels, conceptcalculatie, offertes, project-CMS + generatie, instellingen, webhook-bezorging (achtergrondlus in dit proces) |

De poorten 8130 en 8131 zijn vrij volgens `/etc/handsfree/poorten.md`; Bob moet ze daar
registreren. Beide diensten delen één SQLite-database in WAL-modus (twee processen is
prima voor dit volume). De publieke dienst schrijft alleen nieuwe dossiers, uploads en
outbox-events; hij leest nooit andermans dossier.

**Publieke API (aanvraag.mjs)**

| Methode + pad | Doel |
|---|---|
| `POST /api/aanvraag/sessie` | Start een wizardsessie, geeft een willekeurig token (32 bytes) terug. Bevat nog geen persoonsgegevens. |
| `POST /api/aanvraag/upload?soort=foto\|plattegrond\|tegel` | Eén bestand per verzoek, raw body, header `x-sessie`. Foto's worden client-side verkleind tot JPEG ≤ 2048 px; plattegrond mag JPEG/PNG/WebP/PDF ≤ 15 MB. Magic bytes worden gecontroleerd, bestandsnaam wordt nooit gebruikt (opslag onder een uuid). |
| `DELETE /api/aanvraag/upload/:id` | Upload weer weghalen in de wizard. |
| `POST /api/aanvraag/plattegrond/:uploadId/analyse` | Plattegrond laten lezen (stap 5 van de fasering). Tot die tijd: 503 → wizard valt terug op handmatig invullen. |
| `POST /api/aanvraag/indienen` | Alle wizardantwoorden + contactgegevens. Valideert, koppelt de uploads, maakt het dossier, en meldt pas daarna. Antwoord bevat de samenvatting voor het bedankscherm. |

Uploads van een sessie die binnen 24 uur niet ingediend wordt, worden automatisch
verwijderd (opruimlus in de dienst).

### 1.4 Datamodel (SQLite)

Bestand: `/var/lib/dekoning/dekoning.db` (systemd `StateDirectory=dekoning`). Schemaversie
via `PRAGMA user_version`; migraties draaien bij het opstarten. Bedragen in **centen**
(integer), oppervlaktes in m² met één decimaal.

| Tabel | Belangrijkste kolommen |
|---|---|
| `wizard_sessies` | `token` (hash), `aangemaakt_op`, `ip_hash`, `ingediend` |
| `aanvragen` (het projectdossier) | `id`, `nummer` (bijv. `2026-0001`), `status`, `naam`, `email`, `telefoon`, `postcode`, `huisnummer`, `straat`/`plaats` (via PDOK aangevuld), `toelichting`, `antwoorden_json` (ruwe wizardantwoorden, met versie van `wizard.json`), `tegelkeuze`, `tegels_aanwezig`, `ontvangen_op`, `bijgewerkt_op`, `mail_klant_verzonden`, `mail_intern_verzonden`, `bewaren_tot` |
| `aanvraag_ruimtes` | `aanvraag_id`, `naam`, `soort` (badkamer, toilet, …), `vloer_m2`, `wand_m2`, `omtrek_m`, `bron` (`klant`, `plattegrond`, `beheer`), `zekerheid`, `geselecteerd` |
| `aanvraag_werkzaamheden` | `aanvraag_id`, `ruimte_id` (optioneel), `sleutel` (vloer, wanden, verwijderen, egaliseren, waterdichting, nissen, plinten, onzeker) |
| `bestanden` | `id` (uuid), `aanvraag_id`/`sessie`, `soort` (foto, plattegrond, tegel, project), `mime`, `bytes`, `sha256`, `pad` (relatief), `aangemaakt_op` |
| `analyses` | `bestand_id`, `soort` (plattegrond, foto), `model`, `resultaat_json` (genormaliseerd), `zekerheid`, `fout`, `aangemaakt_op` |
| `status_log` | `aanvraag_id`, `van`, `naar`, `door`, `op`, `toelichting` |
| `notities` | `aanvraag_id`, `tekst`, `door`, `op` |
| `calc_regels` | `sleutel`, `label`, `eenheid` (m2, m, stuk, vast), `prijs_cent`, `categorie` (tegelwerk, voorbereiding, afwerking, overig), `actief`, `volgorde` |
| `calc_toeslagen` | `sleutel`, `label`, `soort` (`pct` of `vast`), `waarde`, `voorwaarde_json` (bijv. `{"tegelformaat":["120x120","xxl"]}`, `{"patroon":"visgraat"}`, `{"ruimte_max_m2":4}`), `geldt_voor` (regelcategorieën), `actief` |
| `calc_instellingen` | `snijverlies_pct` (per patroon/formaat), `minimum_cent`, `voorrijkosten_json` (per postcodegebied of afstandsband), `btw_pct`, `geldigheid_dagen` |
| `calculaties` | `id`, `aanvraag_id`, `versie`, `bron` (`automatisch`, `handmatig`), `tarieven_snapshot_json`, `totaal_ex_cent`, `aangemaakt_op` |
| `calculatie_regels` | `calculatie_id`, `regel_sleutel` (of vrij), `omschrijving`, `hoeveelheid`, `eenheid`, `prijs_cent`, `toeslagen_json`, `handmatig_aangepast` |
| `offertes` | `id`, `nummer`, `aanvraag_id`, `calculatie_id`, `versie`, `status`, `projectadres`, `opties_json`, `voorwaarden`, `geldig_tot`, `btw_pct`, `totaal_ex_cent`, `btw_cent`, `totaal_incl_cent`, `klant_token` (hash, voor een eventuele klantpagina), `verzonden_op`, `akkoord_op` |
| `projecten` | `id`, `slug`, `naam`, `plaats`, `projecttype`, `omschrijving`, `tegelformaat`, `materiaal`, `oppervlak`, `werkzaamheden`, `bijzonderheden`, `cat_badkamer`, `cat_vloer`, `cat_toilet`, `cat_xxl`, `cat_visgraat`, `cat_natuursteen`, `uitgelicht`, `volgorde`, `gepubliceerd_op` |
| `project_fotos` | `project_id`, `soort` (voor, na, detail), `bestand_id`, `alt`, `breedte`, `hoogte`, `volgorde`, `ook_elders` (homepage/dienstpagina/detailsectie) |
| `reviews` | `id`, `naam_weergave`, `sterren`, `tekst`, `projecttype`, `bron` (google, anders), `bron_url`, `datum`, `toestemming` (ja/nee), `zichtbaar` |
| `instellingen` | sleutel/waarde: bedrijfsgegevens, vertrouwenselementen, WhatsApp-tekst, werkgebied, reviewscore + bron + peildatum |
| `gebruikers` | `id`, `naam`, `email`, `wachtwoord_hash` (scrypt + salt), `actief`, `laatst_ingelogd` |
| `sessies` | `token_hash`, `gebruiker_id`, `aangemaakt_op`, `verloopt_op`, `ip_hash` |
| `webhook_endpoints` | `id`, `naam`, `url`, `events` (lijst), `actief` |
| `webhook_events` (outbox) | `id`, `event`, `payload_json`, `aangemaakt_op`, `pogingen`, `volgende_poging`, `afgeleverd_op`, `laatste_fout` |
| `dagteller` | `datum`, `soort` (aanvraag, upload, analyse), `aantal` — daglimieten overleven een herstart |

### 1.5 Opslag van uploads (buiten de webroot)

```
/var/lib/dekoning/
├── dekoning.db
└── uploads/
    ├── sessies/<sessie-hash>/<uuid>.<ext>      nog niet ingediend, na 24 uur weg
    └── aanvragen/<nummer>/<uuid>.<ext>         na indienen hierheen verplaatst
```

- Nooit onder de webroot, nooit via een voorspelbare URL. Het beheer vraagt een bestand op
  via `GET /api/beheer/bestand/:uuid`; de dienst controleert de sessie en antwoordt met
  `X-Accel-Redirect: /_beschermd/...`, waarna nginx het bestand uit een `internal`-location
  serveert. Zo hoeft Node geen grote bestanden te streamen.
- Foto's van klanten worden in de browser verkleind tot JPEG; dat haalt EXIF (incl.
  GPS-locatie) er meteen af. PDF's worden ongewijzigd bewaard.
- De dienst draait met `ProtectSystem=strict`; alleen `/var/lib/dekoning` en de
  generatiemap zijn schrijfbaar.

Projectfoto's (publiek) zijn iets anders: die staan in
`/var/www/dekoningtegelwerken.nl/media/projecten/` (buiten de git-werkkopie), in meerdere
breedtes als WebP. `cwebp` staat al op hfd-web01; AVIF vraagt `avifenc` (libavif-tools),
zie open vraag 8. Het originele bestand wordt nooit gepubliceerd.

### 1.6 Statussen en events

Statusflow uit §17, met twee zijstatussen die in de praktijk nodig zijn:

```
nieuw → beoordelen → calculatie → offerte_klaar → verzonden → akkoord
                                               ↘ afgewezen
(elk moment) → gearchiveerd
```

Elke overgang komt in `status_log`. Er is **geen enkele automatische overgang naar
`verzonden`**: versturen is altijd een handeling in het beheer, na het bekijken van het
concept.

Webhook-events (§30), met het moment waarop ze ontstaan:

| Event | Wanneer | Payload (kern) |
|---|---|---|
| `new_lead` | Aanvraag opgeslagen (na indienen) | dossiernummer, ruimtes, oppervlaktes, aantallen bestanden, plaats. **Geen** naam/e-mail/telefoon tenzij een endpoint dat expliciet mag (instelling per endpoint) |
| `floorplan_uploaded` | Aanvraag met plattegrond opgeslagen, of plattegrond later in het beheer toegevoegd | dossiernummer, bestand-id, analyse-uitkomst indien aanwezig |
| `lead_completed` | Dossier is compleet: er zijn foto's én een oppervlak bekend (bij indienen, of zodra het later in het beheer wordt aangevuld) — **besluit Bob** | dossiernummer, totaal m², aantal foto's |
| `quote_created` | Conceptofferte aangemaakt | offertenummer, versie, totaal |
| `quote_sent` | Offerte verstuurd | offertenummer, verzonden_op |
| `quote_accepted` | Klant klikt op de akkoordknop op de klantpagina (of De Koning zet handmatig op `akkoord`) | offertenummer, akkoord_op |
| `appointment_requested` | Klant vraagt via de klantpagina een inmeetafspraak aan — **besluit Bob** | dossiernummer, voorkeursmomenten |

Bezorging: event komt in dezelfde transactie als de wijziging in de outbox; de
achtergrondlus in `beheer.mjs` post het als JSON met `X-DeKoning-Event`,
`X-DeKoning-Id` en `X-DeKoning-Handtekening` (HMAC-SHA256 met een geheim uit het
env-bestand), en probeert opnieuw met oplopende wachttijd (1 min → 24 uur, maximaal
10 pogingen). Ontvangers moeten op `X-DeKoning-Id` ontdubbelen.

### 1.7 Project-CMS zonder build-step

Zelfde principe als de praktijkvoorbeelden: het beheer **genereert statische bestanden**,
nginx serveert ze; de site zelf blijft gewone HTML.

Bij "Publiceren" in het beheer schrijft `generator.mjs` naar
`/var/www/dekoningtegelwerken.nl/gegenereerd/` (buiten de git-werkkopie, dus een deploy
raakt ze niet):

| Bestand | Gebruikt door |
|---|---|
| `projecten/<slug>/index.html` | Projectdetailpagina, gevuld vanuit `projecten/_sjabloon.html` (titel, meta, JSON-LD, hero, projectinformatie, fotogalerij voor/na/detail, CTA). nginx: `location /projecten/ { try_files $uri $uri/ /gegenereerd$uri ...; }` |
| `fragmenten/projectgrid-home.html` | Homepage-grid, via `<!--# include virtual=... -->` (SSI alleen aan op de pagina's die het nodig hebben) |
| `fragmenten/projectgrid-alle.html` | `/projecten/` met alle kaarten; de filterknoppen werken client-side op `data-categorie`-attributen, zonder extra verzoek |
| `fragmenten/projecten-<categorie>.html` | "Bekijk vergelijkbaar werk" op de dienstpagina's |
| `fragmenten/voor-na.html`, `fragmenten/details.html` | Voor/na-slider en detailsectie met foto's die in het CMS als "ook elders" zijn gemarkeerd |
| `fragmenten/vertrouwen.html`, `fragmenten/reviews.html` | Vertrouwenselementen en reviews uit de instellingen |
| `sitemap.xml` | Vaste pagina's + gepubliceerde projecten |

Omdat de kaarten als echte HTML in de pagina staan (en niet pas via JavaScript), zijn ze
direct zichtbaar voor zoekmachines en is er geen laadflits. Is er nog geen enkel project,
dan is het fragment leeg en toont de pagina de placeholderkaarten uit de HTML zelf
(`ssi_silent_errors on`).

Lokaal en in stap 1, nog zonder beheer, komt dezelfde inhoud uit
`data/projecten.voorbeeld.json` via een klein script `service/cli/genereer.mjs`, zodat het
sjabloon vanaf het begin hetzelfde is als in productie.

### 1.8 Auth voor het beheer

- Beheer op **`beheer.dekoningtegelwerken.nl`** (eigen vhost, `noindex`, eigen cookie-scope);
  alternatief `/beheer/` op het hoofddomein — zie open vraag 12.
- Inloggen met e-mail + wachtwoord; hash met `crypto.scrypt` (ingebouwd) + per-gebruiker salt.
  Accounts aanmaken alleen via de CLI op de server (`node service/cli/gebruiker.mjs`), er
  is geen registratiescherm.
- Sessiecookie `__Host-dk_sessie`: `HttpOnly`, `Secure`, `SameSite=Strict`, 14 dagen
  schuivend; in de database alleen de hash van het token.
- Alle wijzigende verzoeken controleren `Origin` (CSRF), plus `SameSite=Strict`.
- Rate limit op inloggen (5 pogingen per 15 min per IP én per account), daarna vertraging.
- Tweede factor (TOTP, met `node:crypto` te bouwen) als vervolgstap in fase 4, niet
  meteen — zie open vraag 12.

### 1.9 Calculatie-engine

Eén pure module `js/gedeeld/calculatie.js` (geen DOM, geen opslag), door de server
geïmporteerd voor de conceptcalculatie en door het beheer voor live herrekenen. **Geen
prijs staat in de frontend van de publieke site**: de wizard kent de module niet nodig en
de tarieven staan alleen in de database.

Rekenvolgorde per calculatie:

1. Hoeveelheden uit het dossier: vloer- en wand-m² per ruimte (klant, plattegrond of
   beheer), strekkende meters plint (default: omtrek − deurbreedtes, als suggestie),
   aantallen nissen/verstekhoeken.
2. Snijverlies op het **tegeloppervlak** (alleen informatief voor tegelinkoop; arbeid
   rekent op netto m²), afhankelijk van formaat/patroon (bijv. recht 10 %, visgraat 15 %
   — waarden instelbaar, nu placeholders).
3. Per regel: hoeveelheid × prijs uit `calc_regels`.
4. Toeslagen uit `calc_toeslagen` waarvan de voorwaarde klopt (tegelformaat, patroon,
   ondergrond, verdieping, bereikbaarheid, snijwerk, kleine ruimte, grootformaat,
   natuursteen), als percentage op de regels van de genoemde categorieën of als vast bedrag.
5. Voorrijkosten volgens postcodegebied/afstandsband (alleen als De Koning dat wil).
6. Minimum projectbedrag.
7. Btw (tarief instelbaar, zie open vraag 9) en totaal.

Elke regel blijft in het beheer aanpasbaar (hoeveelheid, prijs, weglaten, vrije regel
toevoegen); aangepaste regels worden gemarkeerd. Bij elke calculatie wordt een snapshot
van de tarieven bewaard, zodat een latere tariefwijziging een oude offerte niet verandert.

**"AI-conceptcalculatie"** (§17) wordt bewust zo ingevuld: de **berekening zelf is
deterministisch** (regels × hoeveelheden, reproduceerbaar en uitlegbaar). AI levert alleen
**invoer met een zekerheidslabel**: ruimtes en m² uit de plattegrond, en een korte
fotosamenvatting (ondergrond, bestaande tegels, aandachtspunten zoals leidingwerk of
scheuren). Alles wat uit AI komt, staat in het dossier herkenbaar als "suggestie" en telt
pas mee nadat De Koning het heeft bevestigd of aangepast.

### 1.10 Design system (stap 1)

- Kleur als CSS-variabelen in `css/basis.css`: warm off-white/zand (achtergrond),
  antraciet (tekst en donkere secties), één gedempt brons/steen-accent. Exacte waarden
  worden in stap 1 vastgelegd en op contrast (WCAG AA) gecontroleerd; als er een logo
  komt, wordt het palet daarop afgestemd.
- Typografie: één rustige, architectonische koppenletter + een goed leesbare tekstletter,
  **zelf gehost** (geen verzoek naar Google; sneller en geen AVG-discussie). Keuze in stap 1
  met twee varianten ter beoordeling.
- Grid, ruimteschaal, dunne lijnen, afgeronde hoeken alleen op knoppen/invoer.
- Animatie alleen met IntersectionObserver + CSS-transities, alles uit bij
  `prefers-reduced-motion` (zoals op handsfree-digital.nl). Geen parallax, geen libraries.
- Afbeeldingen: `<picture>` met WebP (en AVIF zodra beschikbaar), `width`/`height` altijd
  gezet, hero met `fetchpriority="high"`, de rest `loading="lazy"`.
- Doelen: LCP < 2,5 s op mobiel 4G, CLS < 0,05, geen horizontale overflow vanaf 320 px.

### 1.11 Placeholders

Alle bedrijfsgegevens komen uit één bron (`data/site.json`, later de tabel `instellingen`)
en verschijnen als zichtbaar gemarkeerde placeholder, bijv. `[TELEFOONNUMMER]`, in een
eigen stijl (`.placeholder`: gestippelde rand, monospaced). Regel:

- **staging/preview**: placeholders zichtbaar, zodat duidelijk is wat nog ontbreekt;
- **productie**: een element waarvan de gegevens ontbreken, wordt **weggelaten** (geen
  "[X]+ jaar ervaring" en geen lege sterren op de live site). JSON-LD wordt alleen
  uitgevoerd met echte NAP-gegevens.

Foto's: neutrale vlakken in de paletkleur met het label "Projectfoto volgt" en de
beoogde beeldverhouding. **Geen AI-gegenereerde of stockfoto's van tegelwerk**: op een site
die met eigen vakmanschap adverteert, zou dat misleidend zijn (zie open vraag 2).

---

## 2. Fasering

Elke stap is los op te leveren, op een eigen branch (`fase-1-design`, …), met een korte
oplevernotitie. Bob beoordeelt en merget naar `main`. Een stap is pas klaar als hij op
mobiel (360 px) én desktop is nagelopen en de tests groen zijn.

### Stap 1 — Design system, homepage, projecten, dienstpagina's (placeholders)

1a. Design system + basislayout: tokens, typografie, header (transparant → compact bij
    scrollen), mobiel menu, sticky "Offerte aanvragen" onderin op mobiel, footer met
    "Website & automatisering door Handsfree Digital", WhatsApp-CTA als tekstlink.
1b. Homepage met alle secties uit §3–§9, §20, §21 en §33: hero, vertrouwenselementen
    (verborgen zonder data), asymmetrische projectgrid met filters, specialismenkaarten,
    detailsectie met hotspots/kaarten, voor/na-slider (toetsenbord- en touchbediening),
    werkwijze-tijdlijn, reviewsectie (leeg = weggelaten), over-ons-blok, CTA's.
1c. `/projecten/` + projectdetailsjabloon + `service/cli/genereer.mjs` met
    voorbeelddata (placeholders).
1d. Dienstpagina's (§22) met unieke opbouw per dienst: wat het is, waar het op aankomt,
    gerelateerde projecten, korte FAQ alleen waar die echt iets toevoegt, CTA. Plus
    `/werkwijze/`, `/over-ons/`, `/contact/`, `/privacy/` en `/algemene-voorwaarden/` als
    sjabloon met placeholders.
1e. SEO-basis: titels/omschrijvingen, canonical, Open Graph, `robots.txt`, `sitemap.xml`,
    BreadcrumbList en Service als JSON-LD; LocalBusiness pas als de NAP-gegevens er zijn.
1f. `CLAUDE.md` voor deze repo, `deploy/`-voorbeelden voor een preview-vhost.

**Oplevering**: complete klikbare site op een preview-adres, alleen placeholders.

### Stap 2 — Offertewizard `/offerte` (frontend + fallbacks)

- Zes stappen, één vraag per scherm op mobiel, voortgang "Stap 1 van 6", grote
  keuzekaarten, vloeiende overgangen (uit bij reduced motion), terug-knop behoudt antwoorden.
- **Progressive disclosure** volledig uit `data/wizard.json`: per gekozen ruimte alleen de
  relevante werkzaamheden (geen waterdichting/nissen bij alleen een woonkamer; "Buiten"
  krijgt eigen vragen over ondergrond/vorstbestendigheid; "Anders" een vrij veld). Stap 3
  vraagt m² per gekozen ruimte, met "Weet je het niet precies?" → plattegrond uploaden of
  lengte × breedte invullen.
- Stap 4 tegels (formaten, "al gekocht?", tegelfoto), stap 5 foto's met **"Maak foto"**
  (`capture="environment"`) en **"Kies uit foto's"**, voorbeeldlijst wat handig is,
  stap 6 contact (alleen de zes velden uit §14 + privacy-checkbox), knop
  **"Verstuur mijn aanvraag"**.
- Postcode + huisnummer → straat en plaats via PDOK Locatieserver (zoals in de demo),
  als bevestiging, niet verplicht.
- Toestand in `sessionStorage`: een herladen pagina of een terugknop verliest niets.
- **Fallbacks zolang de backend er niet is**: uploads blijven lokaal in de wizard;
  plattegrondanalyse toont direct "vul zelf de maten in"; bij indienen een nette melding
  met de samenvatting en de keuze om die via e-mail of WhatsApp door te sturen (vooraf
  ingevulde tekst, zonder bijlagen). Er wordt niets gesimuleerd alsof het verstuurd is.
- Bedankscherm (§19) met samenvatting uit de eigen antwoorden.
- Toegankelijkheid: echte `<fieldset>`/`<legend>`, focus naar de nieuwe stapkop,
  foutmeldingen bij het veld, bedienbaar met toetsenbord.

**Oplevering**: volledige wizard op het preview-adres, zonder backend bruikbaar met eerlijke terugval.

### Stap 3 — Backend: aanvraag → projectdossier, uploads, bevestigingsmail, events

- `service/aanvraag.mjs` + `lib/db.mjs`, `lib/beveiliging.mjs`, `lib/mail.mjs`,
  `lib/webhooks.mjs` (alleen de outbox; bezorging komt met het beheer in stap 4, of eerder
  via een kleine bezorglus in deze dienst als Bob de events al wil gebruiken).
- Sessie → uploads → indienen → dossier, in die volgorde opgeslagen, daarna melden:
  bevestigingsmail aan de klant (samenvatting, geen bijlagen terug), meldingsmail aan
  De Koning met het dossier als leesbare tekst (zoals in §15) en een link naar het beheer
  (zodra dat er is), optioneel Telegram.
- Spambescherming (zie open vraag 13), daglimieten, opruimen van niet-ingediende uploads,
  automatisch verwijderen na de bewaartermijn.
- `service/cli/aanvragen.mjs` om dossiers op de server te bekijken zolang er geen beheer is.
- Tests: validatie, magic bytes, honeypot/invultijd, opslaan-vóór-melden (mail plat →
  aanvraag staat er toch).
- `deploy/`: unit-bestand, nginx-locations (`client_max_body_size` per route),
  env-sjabloon.

**Oplevering**: echte aanvragen komen binnen als dossier + mail; Bob zet units en vhost aan.

### Stap 4 — Beheer, calculatieregels, statussen, conceptofferte/PDF

4a. Inloggen, dashboard (nieuw, te beoordelen, offertes openstaand, akkoord, recent),
    aanvragenlijst, dossierscherm (klantgegevens, plattegrond, foto's met lightbox,
    ruimtes en oppervlaktes bewerkbaar, werkzaamheden, interne notities, statuslog),
    statusknoppen.
4b. Calculatieregels en toeslagen beheren (tabel met inline bewerken, voorwaarden via
    keuzelijsten, geen JSON typen), instellingen (snijverlies, minimum, voorrijkosten,
    btw, geldigheid).
4c. Conceptcalculatie per dossier (automatisch voorstel uit de regels, alles wijzigbaar),
    "Maak offerte" → conceptofferte met de velden uit §18, versies.
4d. Concept bekijken, aanpassen, PDF genereren (zie open vraag 7), offerte versturen
    (mail met PDF of link; altijd een bevestigingsstap), status akkoord, events
    `quote_created`/`quote_sent`/`quote_accepted`, webhook-bezorging + instelscherm met
    testknop en laatste afleveringen.
4e. Project-CMS (velden en checkboxen uit §23, foto's uploaden met client-side verkleinen
    en server-side WebP via `cwebp`, volgorde slepen, alt-tekst verplicht) + publiceren →
    generator. Website-instellingen: vertrouwenselementen, reviews, WhatsApp, contactgegevens.

**Oplevering**: De Koning kan zelfstandig dossiers afhandelen, offertes maken en projecten publiceren.

### Stap 5 — Plattegrondanalyse en AI-conceptcalculatie

- `lib/analyse.mjs` met het overgenomen `PLATTEGROND_PROFIEL` en `normaliseerPlattegrond()`,
  uitgebreid met PDF-invoer en woordenlijst voor ruimtesoorten (badkamer, toilet, hal,
  bijkeuken, …).
- In de wizard: "We hebben deze ruimtes gevonden." met per ruimte "circa X m²", vinkjes,
  en de vaste zin uit §11. Ruimtes met `zekerheid: geen` staan er wel, maar met een
  invulveld in plaats van een getal. Mislukt de analyse, is hij te traag (> 45 s) of is
  alles onzeker: direct door naar handmatig invullen, zonder foutmelding-gevoel.
- Richting de klant **geen AI-terminologie** (§32): "We hebben je plattegrond bekeken",
  niet "onze AI".
- Foto-samenvatting voor het dossier (alleen intern, na indienen, op de achtergrond).
- Conceptcalculatie gebruikt die invoer pas na bevestiging (zie §1.9).
- Evaluatieset: 10–20 echte, geanonimiseerde plattegronden van De Koning met bekende maten
  om de afwijking te meten vóór het live gaat; de uitkomst bepaalt of de m² in de wizard
  getoond worden of alleen intern.

**Oplevering**: plattegrondherkenning live, met gemeten nauwkeurigheid en terugval.

---

## 3. Ontbrekende gegevens (aan te leveren door Bob / De Koning)

Niets hiervan wordt verzonnen; tot het er is, staat er een gemarkeerde placeholder of
wordt het element weggelaten.

| # | Gegeven | Waar gebruikt | Placeholder |
|---|---|---|---|
| 1 | Logo (SVG, liefst ook een versie voor donkere achtergrond) en eventuele huisstijlkleuren | Header, footer, favicon, OG-afbeelding, offerte | `[LOGO]` als woordmerk in tekst |
| 2 | Echte projectfoto's, hoge resolutie, per project gegroepeerd (voor/na/detail) + per project: naam, plaats, type, formaten, materiaal, m², werkzaamheden, bijzonderheden | Hero, grid, projectpagina's, voor/na, detailsectie | "Projectfoto volgt"-vlakken |
| 3 | Hero-beeld of -video (rustig, eigen werk) | Hero | Effen vlak in paletkleur |
| 4 | Officiële bedrijfsnaam zoals ingeschreven, KvK-nummer, btw-id (voor offertes) | Footer, offerte, JSON-LD | `[KVK-NUMMER]`, `[BTW-ID]` |
| 5 | Bezoek- of postadres (of de keuze om geen adres te tonen) | Footer, contact, LocalBusiness | `[ADRES]` |
| 6 | Telefoonnummer | Header (mobiel), contact, footer, mails | `[TELEFOONNUMMER]` |
| 7 | WhatsApp-nummer (en of het hetzelfde is als 6) | WhatsApp-CTA's | `[WHATSAPP-NUMMER]` |
| 8 | E-mailadres voor klanten + het adres waar meldingen heen moeten | Contact, mails, Reply-To | `[E-MAIL]` |
| 9 | Werkgebied/regio (plaatsen of straal) | Hero, contact, footer, dienstpagina's, eventuele lokale pagina's, voorrijkosten | `[REGIO]` |
| 10 | Aantal jaren ervaring (en sinds wanneer, dan telt het zelf door) | Vertrouwenselement, over ons | weggelaten |
| 11 | Google Bedrijfsprofiel-link, huidige score en aantal reviews; welke reviews getoond mogen worden (met toestemming van de schrijver) | Vertrouwenselement, reviewsectie | weggelaten |
| 12 | Prijzen voor alle calculatieregels en toeslagen (§16), snijverlies, minimumbedrag, voorrijkosten, btw-situatie | Calculatie-engine | Beheer start leeg; zonder prijs geen automatisch voorstel |
| 13 | Offertevoorwaarden, geldigheidsduur, betalingstermijnen; eigen algemene voorwaarden (of lidmaatschap van een branchevereniging met voorwaarden) | Offerte, `/algemene-voorwaarden/` | `[VOORWAARDEN]` |
| 14 | Foto van de eigenaar aan het werk + kort eigen verhaal (wie, sinds wanneer, waarom dit vak, specialisaties, werkwijze) — liefst in eigen woorden, wij redigeren | Over ons | `[EIGENAARSFOTO]`, `[VERHAAL]` |
| 15 | Naam van de eigenaar zoals die op de site mag (en hoe aangesproken in teksten) | Over ons, mails | `[NAAM EIGENAAR]` |
| 16 | Eventuele certificeringen, garanties of lidmaatschappen (alleen als ze echt zijn) | Over ons, dienstpagina's | weggelaten |
| 17 | Welke diensten echt geleverd worden (doet De Koning ook buitenwerk, natuursteen, egaliseren, sloopwerk, waterdichting zelf?) | Dienstpagina's, wizardopties | alle opties uit de briefing, te schrappen |
| 18 | Voorbeeldplattegronden met bekende maten (geanonimiseerd) | Evaluatie stap 5 | — |

---

## 4. Wat Bob zelf moet doen

Voor mij zijn `systemctl` en mergen naar `main` geblokkeerd; ik lever voorbeelden aan in
`deploy/`, Bob voert ze uit.

**Nu al (vóór stap 1)**

1. Git-identiteit instellen voor deze repo (root heeft er geen), bijv.
   `git -C /root/dekoning-tegelwerken config user.name "…"` en `user.email`, en beslissen
   of ik per stap op een branch mag committen.
2. Beslissen waar de productie-werkkopie komt (zoals bij handsfree-digital.nl een
   CloudPanel-site onder `/home/<gebruiker>/htdocs/dekoningtegelwerken.nl`?) en of er een
   eigen systeemgebruiker `dekoning` komt (voorstel: ja, los van `handsfree`).

**Stap 1 (preview)**

3. Preview-vhost aanzetten: voorstel via het tailnet (zoals `hfd-web01-tailnet.conf`) of
   `staging.dekoningtegelwerken.nl` met basic auth en `X-Robots-Tag: noindex`.

**Stap 3 (backend live)**

4. DNS bij de registrar: A/AAAA voor `dekoningtegelwerken.nl`, `www` en (indien gekozen)
   `beheer`; `www` → 301 naar het kale domein (of omgekeerd, kiezen).
5. TLS-certificaten (Let's Encrypt via CloudPanel of certbot) voor alle hostnamen.
6. nginx-vhost op basis van `deploy/nginx-dekoningtegelwerken.nl.conf`: statische site,
   `ssi on` alleen op de pagina's met fragmenten, `/api/aanvraag/` → 8130 met
   `client_max_body_size 16m`, `/api/beheer/` → 8131, `internal`-location voor beschermde
   uploads, de generatiemap, security headers (CSP, HSTS, Referrer-Policy), cache-headers
   voor assets.
7. Mappen aanmaken met de juiste eigenaar: `/var/www/dekoningtegelwerken.nl/gegenereerd/`
   en `/media/` (schrijfbaar voor `dekoning`), `/var/lib/dekoning` komt via `StateDirectory`.
8. Env-bestand `/etc/dekoning/dekoning.env` (mode 0640, root:dekoning) op basis van
   `deploy/dekoning.env.voorbeeld`: `ANTHROPIC_API_KEY`, `POSTMARK_SERVER_TOKEN`,
   `MAIL_VAN`, `MAIL_NAAR`, optioneel `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`,
   `WEBHOOK_GEHEIM`, `SITE_URL`.
9. Postmark: afzenderdomein `dekoningtegelwerken.nl` verifiëren (DKIM- en
   Return-Path-records in DNS), plus SPF/DMARC; anders landen bevestigingsmails in spam.
10. systemd-units `dekoning-aanvraag` en `dekoning-beheer` installeren (op basis van
    `deploy/`, zelfde hardening als `handsfree-foto-analyse`), `enable --now`.
11. Poorten 8130 en 8131 registreren in `/etc/handsfree/poorten.md`.
12. Back-up: `/var/lib/dekoning` (database én uploads) en `/var/www/dekoningtegelwerken.nl/media`
    meenemen in de bestaande back-up; SQLite consistent kopiëren (`.backup` of
    `VACUUM INTO`), niet het losse bestand tijdens schrijven.

**Stap 4**

13. Beheeraccount(s) aanmaken met `node service/cli/gebruiker.mjs` en het wachtwoord aan
    De Koning overdragen.
14. Eventueel `libavif` (avifenc) installeren als we AVIF willen (open vraag 8).

---

## 5. Open vragen en risico's

> Vragen 4, 5, 6 (bewaartermijn en privacymelding), 7, 8, 9, 10, 12 en 17 zijn
> beantwoord in **Besluiten van Bob** bovenaan dit plan. De tekst hieronder blijft staan
> als achtergrond bij die besluiten.

**Inhoud en merk**

1. **Ontbrekende gegevens** (§3) bepalen hoe "af" stap 1 eruitziet. Zonder echte foto's
   kan het ontwerp wel worden beoordeeld op opbouw, typografie en kleur, maar niet op de
   belangrijkste visuele laag.
2. **Beeld zonder eigen foto's**: voorstel is placeholdervlakken tot er echte foto's zijn.
   Stock- of AI-beeld van tegelwerk zou op een site die met eigen vakmanschap adverteert
   als eigen werk overkomen. Akkoord?
3. **Lokale pagina's**: pas zinvol als het werkgebied bekend is; voorstel maximaal 2–4
   plaatsen waar De Koning echt veel werkt, elk met een eigen project.

**Google Reviews (juridisch/technisch)**

4. De Google Places API geeft per bedrijf hoogstens een handvol (5) reviews terug, eist
   bronvermelding en de juiste weergave, en staat langdurig cachen van inhoud niet toe;
   de API kost geld per verzoek boven het gratis tegoed. Voorstel: **handmatig
   gecureerde echte reviews** in het beheer (met link naar de bron en toestemming van de
   schrijver om de naam te tonen), score + aantal handmatig bijgewerkt met peildatum, en
   "Bekijk alle reviews" naar het Google-profiel. Places API alleen als Bob dat wil,
   na controle van de actuele voorwaarden.
5. **Review-markup**: Google toont geen sterren in zoekresultaten voor reviews die een
   bedrijf over zichzelf op de eigen site zet ("self-serving reviews"). Voorstel: geen
   `Review`/`AggregateRating`-JSON-LD op LocalBusiness; wel gewone, zichtbare reviews.
   Dit wijkt af van §22 en vraagt een akkoord.

**Privacy / AVG**

6. Foto's van iemands woning + naam + adres zijn persoonsgegevens. Nodig:
   - **Privacyverklaring** (inhoud van De Koning als verwerkingsverantwoordelijke; wij
     leveren een concept met wat het systeem doet).
   - **Verwerkersovereenkomsten**: Handsfree Digital (hosting/beheer) met De Koning;
     Postmark en Anthropic als subverwerkers (beide in de VS: doorgifte vermelden).
     Anthropic gebruikt API-data volgens hun commerciële voorwaarden niet voor training;
     dat moet Bob voor de zekerheid bevestigen tegen de actuele voorwaarden.
   - **Bewaartermijn** — voorstel: aanvragen zonder opdracht 12 maanden na laatste
     contact, dan dossier geanonimiseerd en uploads verwijderd; met opdracht: offerte en
     klantgegevens zolang fiscaal nodig (7 jaar), foto's/plattegronden 2 jaar na
     oplevering. De Koning beslist.
   - De plattegrondanalyse gebeurt in stap 3, dus vóór de privacy-checkbox in stap 6.
     Voorstel: een korte zin onder de uploadknop ("We gebruiken je plattegrond alleen om
     de maten te bepalen") en de upload zelf als bewuste handeling van de klant;
     niet-ingediende uploads zijn na 24 uur weg. Bob/De Koning beslissen of dat volstaat.
   - Geen tracking/analytics-cookies → geen cookiebanner nodig. Wil De Koning
     bezoekersstatistieken? Dan cookieloos (bijv. eigen serverlogs of Plausible).
   - Fonts zelf hosten (geen Google Fonts-verzoek met IP-adres).

**Techniek**

7. **PDF zonder dependencies**: er staat geen headless Chromium op hfd-web01. Opties:
   (a) printweergave + "Opslaan als PDF" in de browser (zoals de demo) en de offerte per
   mail als link naar een beveiligde klantpagina; (b) een eigen kleine PDF-schrijver voor
   tekst en tabellen (goed haalbaar, ±300 regels, standaardletter Helvetica, logo als
   afbeelding); (c) Chromium installeren voor server-side PDF. Voorstel: **(b)** voor de
   bijlage + (a) als klantweergave. Keuze bij stap 4.
8. **AVIF**: `cwebp` is aanwezig, `avifenc` niet. WebP alleen is voor Core Web Vitals
   ruim voldoende; AVIF levert nog ~20 % kleinere bestanden. Installeren of niet?
9. **Btw-tarief**: de bestaande tegelzetter-demo rekent 9 % voor woningen ouder dan
   2 jaar. Voor zover ik weet geldt het verlaagde tarief alleen voor arbeid bij isoleren,
   schilderen, stukadoren en behangen, en valt tegelzetten onder 21 %. Ook speelt of
   De Koning de kleineondernemersregeling gebruikt. **Laten bevestigen door de
   boekhouder**; het tarief wordt hoe dan ook een instelling, niet hardcoded.
10. **Betekenis van `lead_completed` en `appointment_requested`**: de briefing definieert
    ze niet en de wizard kent geen afspraakstap. Voorstel: `lead_completed` = dossier gaat
    naar `calculatie` (handmatig "compleet" verklaard); `appointment_requested` = een
    knop "Plan een inmeetafspraak" op het bedankscherm en/of in de offertemail, met
    2–3 voorkeursmomenten (geen agendakoppeling). Klopt dat met wat Handsfree Digital
    eraan wil koppelen?
11. **Nauwkeurigheid plattegrondherkenning**: plattegronden van makelaars staan vaak
    niet op schaal, hebben alleen buitenmaten of gebruiken afgeronde oppervlaktes inclusief
    muren; telefoonfoto's van bouwtekeningen zijn scheef en onscherp. Het profiel uit
    handsfree-digital-werk dwingt eerlijkheid af (afgeleide maat nooit "hoog", geen maat →
    geen getal), maar fouten van 10–20 % per ruimte blijven realistisch. Daarom: altijd
    "circa", altijd te corrigeren, en in de calculatie pas na bevestiging. De evaluatieset
    in stap 5 bepaalt of we de getallen aan de klant tonen.
12. **Beheer-toegang**: eigen subdomein of `/beheer/`? Is één account voor De Koning genoeg,
    of ook een account voor Bob? TOTP direct in stap 4 of later? (Tailscale-only kan niet:
    De Koning zit niet op het tailnet en moet er vanaf de telefoon bij.)
13. **Spambescherming**: voorstel zonder externe diensten — herkomstcontrole, honeypot,
    minimale invultijd, wizardsessie verplicht vóór uploads, rate limits per IP (sessies,
    uploads, indienen, analyses), daglimieten, maximale bestandsgrootte en -aantallen
    (bijv. 12 foto's, 1 plattegrond, 2 tegelfoto's), magic-bytecontrole. De dure stap
    (plattegrondanalyse via de API) krijgt de strengste limiet. Als er toch spam doorkomt:
    Cloudflare Turnstile of Friendly Captcha als vervolgstap (met AVG-afweging).
14. **Kosten Anthropic API**: per plattegrondanalyse een paar cent; met een daglimiet
    begrensd. Wie betaalt en welke limiet (voorstel 50 analyses per dag)?
15. **Bestaand domein/bestaande site?** Als er nu al een site of e-mail op
    dekoningtegelwerken.nl draait: redirects van oude URL's en MX-records niet breken.
16. **Mail aan De Koning**: alleen e-mail, of ook Telegram/WhatsApp-melding? (WhatsApp
    Business API vraagt een apart traject; Telegram is direct te hergebruiken.)
17. **"Offerte versturen"**: per mail met PDF-bijlage, als link naar een klantpagina waar de
    klant akkoord kan geven (levert `quote_accepted` automatisch op), of beide?
