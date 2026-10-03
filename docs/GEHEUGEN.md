# Geheugen — stand van zaken dekoningtegelwerken.nl

Bijgewerkt: 3 oktober 2026, einde fase B (stap 1 uit `docs/PLAN.md`).
Werk dit bestand bij aan het eind van elke fase.

## Waar staan we

| Fase / stap | Status |
|---|---|
| A — inventaris en plan | Klaar, goedgekeurd door Bob op 3 okt 2026. Besluiten staan bovenaan `docs/PLAN.md`. |
| B — stap 1: design system, homepage, projecten, diensten, contact | **Klaar op branch `feature/fase-1-frontend`**, gepusht naar origin, **nog niet gemerged**. Wacht op beoordeling van Bob via de preview. |
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
8. Geheugen bijgewerkt na fase B (dit bestand)

## Getest

- `node --test test/*.test.mjs`: 8/8 geslaagd (generator actueel, links en assets bestaan, één h1 per pagina, geen inline styles/scripts, aria-labels op fotoplaceholders, geen review-structured data, lege site.json).
- `test/interactie.mjs`: 23/23 geslaagd (menu, Escape, focus, sticky CTA, filters + herverdeling, details, slider, placeholders; met onderschepte testgegevens ook vertrouwenselementen, WhatsApp-link met vooraf ingevulde tekst, telefoonlink en het weglaten van lege velden in productiemodus).
- `test/schermafdruk.mjs`: 9 pagina's × 3 breedtes zonder overflow of JS-fouten; afdrukken visueel nagelopen.
- `deploy/preview-deploy.sh` getest met een kopie die naar een tijdelijke map schreef: alleen publieke bestanden (± 0,5 MB), generatorcontrole werkt.
- **Niet getest**: echte nginx-vhost (vereist DNS, certificaat en installatie door Bob), Safari/iOS en Firefox (alleen Chromium beschikbaar), Lighthouse-cijfers.

## Wat Bob nu moet doen

Preview zichtbaar maken: stappen in `deploy/README.md` (DNS-record `preview`, map, wachtwoordbestand, certificaat, vhost, `deploy/preview-deploy.sh feature/fase-1-frontend`). Daarna beoordelen en eventueel mergen.

## Nog aan te leveren (blokkeert "af", niet het bouwen)

Zie `docs/PLAN.md` §3. Het belangrijkste voor de uitstraling: logo (SVG), echte projectfoto's (per project voor/na/detail), hero-beeld, eigenaarsfoto + kort verhaal. Daarnaast telefoon, WhatsApp, e-mail, werkgebied, KvK, jaren ervaring, Google-profiel + score, en controle van de conceptteksten in `data/diensten.json`.

Invullen kan direct in `data/site.json` (gegevens) en `data/projecten.json` (projecten) gevolgd door `node service/cli/genereer.mjs`; vóór livegang `placeholdersTonen` op `false` en de bewakingstest in `test/site.test.mjs` aanpassen.

## Aandachtspunten voor volgende fasen

- `vormen()` (gridritme) staat in de generator én in `js/site.js`: samen wijzigen.
- De voorbeeldkaarten (`pagina: false`) moeten weg zodra er echte projecten zijn.
- Productie-vhost: dezelfde CSP als de preview; assets dan langer cachen (bestandsnamen met versie of `?v=`).
- `/werkwijze/` en `/over-ons/` als eigen pagina's (plan stap 1d) zijn bewust uitgesteld: nu ankers op de homepage.
- De browsertests gebruiken de Playwright-Chromium in `~/.cache/ms-playwright/` op hfd-web01; die is niet door dit project geïnstalleerd.
