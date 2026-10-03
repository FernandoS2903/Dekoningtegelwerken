# Geheugen — stand van zaken dekoningtegelwerken.nl

Bijgewerkt: 3 oktober 2026, na fase B (stap 1) plus sfeerbeelden en logo.
Werk dit bestand bij aan het eind van elke fase.

## Waar staan we

| Fase / stap | Status |
|---|---|
| A — inventaris en plan | Klaar, goedgekeurd door Bob op 3 okt 2026. Besluiten staan bovenaan `docs/PLAN.md`. |
| B — stap 1: design system, homepage, projecten, diensten, contact | **Klaar op branch `feature/fase-1-frontend`**, gepusht naar origin, **nog niet gemerged**. Wacht op beoordeling van Bob via de preview. |
| B+ — sfeerbeelden en logo | Klaar op dezelfde branch: 29 AI-sfeerbeelden overal waar placeholdervlakken stonden, en het logo in header, menu, footer, favicon en og-image. |
| Stap 2 — offertewizard `/offerte` | Niet begonnen. Nu een placeholderpagina ("de online aanvraag volgt binnenkort"). |
| Stap 3 — backend | Niet begonnen. |
| Stap 4 — beheer, calculatie, offertes, project-CMS | Niet begonnen. |
| Stap 5 — plattegrondanalyse, AI-conceptcalculatie | Niet begonnen. |

## Wat er in stap 1 is gebouwd

- **Design system** in `css/site.css`: zand/antraciet/brons, Instrument Serif + Manrope (zelf gehost), dunne lijnen, ruime witruimte, placeholdervlakken met een fijn voegenraster.
- **Homepage** (`index.html`) met alle secties uit de briefing: transparante header over een donkere hero (compact en vast na scrollen), vertrouwenselementen uit `data/site.json` (nu leeg en dus weggelaten), asymmetrisch projectgrid met filters, zes specialismekaarten, detailsectie (uitklapbaar, op desktop één grote foto die meewisselt), voor/na-slider (slepen, toetsenbord, touch), werkwijze-tijdlijn, reviewblok met de placeholder "Echte Google-reviews volgen", over-ons met placeholderverhaal, contact-CTA en footer met "Website & automatisering door Handsfree Digital".
- **Projecten**: `/projecten/` (alle kaarten + filters) en één voorbeeldprojectpagina `/projecten/voorbeeldproject-badkamer-grootformaat/` (noindex, niet in de sitemap) met projectinformatie, eindresultaat, voor/na en detailfoto's.
- **Dienstpagina's** uit §22: `/tegelzetter/` (overzicht), `/badkamer-tegelen/`, `/vloer-betegelen/`, `/toilet-betegelen/`, `/grootformaat-tegels/`, `/xxl-tegels/`, `/visgraat-tegels/`, `/natuursteen/`, elk met Service- en BreadcrumbList-JSON-LD.
- **Overig**: `/contact/` (aanvraag prominenter dan contact, contactformulier volgt), `/offerte/` (placeholder), `/privacy/` en `/algemene-voorwaarden/` (placeholder, noindex), `404.html`, `robots.txt`, `sitemap.xml`.
- **Mobiel**: volledig-schermmenu met focus-trap, sticky "Offerte aanvragen" + WhatsApp onderin (na de hero), geen horizontale overflow op 360/820/1440 px (getest).
- **Generator** `service/cli/genereer.mjs`, **tests** in `test/` en **deploy-voorbeelden** in `deploy/` (zie `CLAUDE.md`).

## Commits op `feature/fase-1-frontend`

1. Plan en briefing voor dekoningtegelwerken.nl vastleggen
2. Design system: tokens, typografie, componenten en gedrag
3. Generator, sjablonen en data voor projecten en diensten
4. Pagina's van stap 1: homepage, projecten, diensten en contact
5. Tests: statische controles en browsertests zonder dependencies
6. Voorbeeld-vhost en deploy-script voor de preview
7. CLAUDE.md voor deze repo en plan bijgewerkt
8. Geheugen bijgewerkt na fase B
9. Sfeerbeelden genereren via KIE.AI
10. Sfeerbeelden op de site verwerken
11. Logo van De Koning Tegelwerken verwerken
12. Geheugen en documentatie bijgewerkt na sfeerbeelden en logo

## Getest

- `node --test test/*.test.mjs`: 11/11 geslaagd (na sfeerbeelden en logo; o.a. ook srcset-bestanden, afmetingen, alt-teksten en sfeerbeeld-markering)
- Eerder: 8/8 geslaagd (generator actueel, links en assets bestaan, één h1 per pagina, geen inline styles/scripts, aria-labels op fotoplaceholders, geen review-structured data, lege site.json).
- `test/interactie.mjs`: 23/23 geslaagd (menu, Escape, focus, sticky CTA, filters + herverdeling, details, slider, placeholders; met onderschepte testgegevens ook vertrouwenselementen, WhatsApp-link met vooraf ingevulde tekst, telefoonlink en het weglaten van lege velden in productiemodus).
- `test/schermafdruk.mjs`: 9 pagina's × 3 breedtes zonder overflow, JS-fouten of 404's (de browsertests melden sinds de logo-commit ook mislukte verzoeken); logo gecontroleerd boven de hero, in de compacte header en in de footer.
- `deploy/preview-deploy.sh` getest met een kopie die naar een tijdelijke map schreef: alleen publieke bestanden (± 0,5 MB), generatorcontrole werkt.
- **Niet getest**: echte nginx-vhost (vereist DNS, certificaat en installatie door Bob), Safari/iOS en Firefox (alleen Chromium beschikbaar), Lighthouse-cijfers.

## Sfeerbeelden (3 oktober 2026, op verzoek van Bob: "overal mooie foto's")

- **29 beelden**, AI-gegenereerd via KIE.AI met `nano-banana-pro` (2K, `POST /api/v1/jobs/createTask`, pollen via `/api/v1/jobs/recordInfo`). 30 generaties in totaal: een eerste run op de achtergrond werd afgebroken (één taak ging daarbij verloren), daarna op de voorgrond in twee parallelle brokken. Geen enkel beeld mislukt. Verbruik 540 credits (18 per beeld); tegoed daarna 8453.
- Manifest met prompts, verhoudingen, breedtes en alt-teksten: `data/beelden.json`; script: `service/cli/kie-beelden.mjs` (sleutel uit `/etc/dekoning/kie.env`, nooit in repo of logs). Het na-beeld van de voor/na is een image-to-image-bewerking van het voor-beeld (zelfde standpunt).
- WebP via `cwebp` (q78) in 3 à 4 breedtes: 93 bestanden, samen 2,8 MB voor álle varianten; een bezoeker laadt alleen de passende breedte. Hero op mobiel 13 KB (800 px), hero desktop 43 KB (2400 px).
- **Eerlijkheid:** elk beeld is `"soort": "sfeerbeeld"`, elke alt-tekst begint met "Sfeerbeeld", projectbeelden dragen zichtbaar het label "Sfeerbeeld", onder de voor/na staat "Sfeerbeelden ter illustratie, geen werk van De Koning Tegelwerken". Voorbeeldprojecten houden placeholdernamen (geen klanten, plaatsen of cases).
- **Vóór livegang:** alle sfeerbeelden vervangen door echte projectfoto's van De Koning, of alleen laten staan waar ze niet als eigen werk worden gepresenteerd (bijv. algemeen sfeerbeeld bij een dienst). Vastgelegd in `docs/PLAN.md` (besluiten).

## Logo (3 oktober 2026)

- Bron: `https://versvanzee.nl/padel-sponsors/de-koning-tegelwerken.svg` (sponsorlogo op de site van Vers van Zee). Die URL zit achter een Cloudflare-controle (403 voor curl); het bestand is daarom **alleen-lezend van vps1** gehaald (`/home/versvanzee-vps1/live-storefront/public/padel-sponsors/`). Het is byte-gelijk aan `De_Koning_Tegelwerken_LOGO_DEF.svg` in de WordPress-uploads van staging.versvanzee.nl, een Illustrator-export.
- Inhoud: ruit (tegel op de punt), "DE KONING" als paden in paars (#551B6B/#4D0E4F), zwarte onderhelft met "TEGELWERKEN" uitgespaard, kroon als **ingebed JPEG** (data-URI, met vectorknippad). Geen scripts, events of externe verwijzingen.
- `assets/brand/logo.svg`: opgeschoond (geen `<style>` of `style`-attributen, strakke viewBox 542×442). `assets/brand/logo-licht.svg`: dezelfde vorm, alle kleuren `#ede6da` (kroon via kleurfilter), voor de donkere hero en de footer.
- Favicon (`assets/favicon.svg`) en `assets/apple-touch-icon.png` (180 px): het vectorpad van de kroon uit het logo in het logopaars op zand, dus een uitsnede en geen nieuw merk. `assets/og-image.jpg` (1200×630): hero-sfeerbeeld met de lichte logovariant en "Tegelwerk tot in detail.".
- **Nog nodig van De Koning:** een officieel bronbestand van het logo (SVG of AI, liefst met de kroon als vector in plaats van een ingebed JPEG), en een besluit of het logopaars ook als accentkleur op de site moet komen (nu gedempt brons).

## Live sinds 3 oktober 2026

Op uitdrukkelijk besluit van Bob staat de site live op **https://dekoningtegelwerken.nl/** (www stuurt door), vóórdat alles klaar was. `main` is daarvoor fast-forward gezet naar de featurebranch (85a2e6d), certificaat via certbot (webroot `/var/www/html`, beide namen), vhost `/etc/nginx/sites-enabled/dekoningtegelwerken.nl.conf` = `deploy/dekoningtegelwerken.nl.conf`, root `/var/www/dekoningtegelwerken`, uitgerold met `deploy/live-deploy.sh --forceer`.

Open punten die nu **openbaar** zichtbaar zijn (de voorcontrole blijft ze melden):
- `placeholdersTonen: false`, dus zonder telefoon, e-mail, WhatsApp en werkgebied staat er op de site geen enkele contactmogelijkheid; alleen het KvK-nummer.
- 6 voorbeeldprojecten (met `[PROJECTNAAM]`/`[PLAATS]`) en sfeerbeelden met het label "Sfeerbeeld" op projectkaarten en de projectpagina.
- Dienstteksten nog niet door De Koning gecontroleerd.

Bijwerken: wijziging mergen naar `main`, daarna `deploy/live-deploy.sh` (met `--forceer` zolang bovenstaande open staat).

## Preview

Preview zichtbaar maken: stappen in `deploy/README.md` (DNS-record `preview`, map, wachtwoordbestand, certificaat, vhost, `deploy/preview-deploy.sh feature/fase-1-frontend`). Daarna beoordelen en eventueel mergen. Bijwerken na nieuwe commits:

```bash
cd /root/dekoning-tegelwerken && deploy/preview-deploy.sh feature/fase-1-frontend
```

## Nog aan te leveren (blokkeert "af", niet het bouwen)

Zie `docs/PLAN.md` §3. Het belangrijkste voor de uitstraling: officieel logobestand, echte projectfoto's (per project voor/na/detail) ter vervanging van de sfeerbeelden, eigenaarsfoto + kort verhaal. Daarnaast telefoon, WhatsApp, e-mail, werkgebied, jaren ervaring, Google-profiel + score, en controle van de conceptteksten in `data/diensten.json`.

**Aangeleverd (3 okt 2026, uittreksel Handelsregister):** KvK 53284046 en adres Appelboomstraat 57, 1971 RA IJmuiden (hoofdvestiging, vestigingsnummer 000023166991, eenmanszaak), ingevuld in `data/site.json`. KvK staat nu in footer en op /contact; het adres staat in site.json maar nog nergens zichtbaar (geen `data-veld="adres"` op de site). Of het adres op de site moet (bij een eenmanszaak vaak het woonadres), is aan De Koning. LocalBusiness-JSON-LD wacht nog op het telefoonnummer.

Invullen kan direct in `data/site.json` (gegevens) en `data/projecten.json` (projecten) gevolgd door `node service/cli/genereer.mjs`; vóór livegang `placeholdersTonen` op `false` en de bewakingstest in `test/site.test.mjs` aanpassen.

## Aandachtspunten voor volgende fasen

- `vormen()` (gridritme) staat in de generator én in `js/site.js`: samen wijzigen.
- De voorbeeldkaarten (`pagina: false`) moeten weg zodra er echte projecten zijn.
- Productie-vhost en `deploy/live-deploy.sh` staan klaar (voorcontrole weigert zolang de site niet klaar is voor livegang); css/js/svg cachen nog kort zolang er geen versie in de bestandsnamen zit.
- `/werkwijze/` en `/over-ons/` als eigen pagina's (plan stap 1d) zijn bewust uitgesteld: nu ankers op de homepage.
- De browsertests gebruiken de Playwright-Chromium in `~/.cache/ms-playwright/` op hfd-web01; die is niet door dit project geïnstalleerd.
