# CLAUDE.md

Richtlijnen voor Claude Code (claude.ai/code) bij werk in deze repository.

## Project

Website **dekoningtegelwerken.nl** voor De Koning Tegelwerken, gebouwd door Handsfree Digital. De briefing staat ongewijzigd in `docs/opdrachten/dekoning-website.md` (§-nummers in comments en docs verwijzen daarnaar), het plan met de fasering en de besluiten van Bob in `docs/PLAN.md`, de actuele stand in `docs/GEHEUGEN.md`. Lees die drie voordat je aan een nieuwe fase begint.

Statische site met één ontwerpsysteem. **Bewust geen frameworks, geen build-step en geen npm-dependencies**: introduceer geen bundlers, preprocessors of packages. Backenddiensten (latere fasen) worden dependency-vrije Node 22-diensten (`node:http`, `node:sqlite`), naar het patroon van `/root/handsfree-digital-werk/service/`.

Alle zichtbare tekst, comments, documentatie en commitberichten zijn **Nederlands**.

## Harde regels

- **Verzin niets.** Geen bedrijfsgegevens, reviews, aantallen, jaren ervaring of prijzen die niet door Bob/De Koning zijn aangeleverd. Ontbreekt iets, dan een herkenbare placeholder (`<span class="ph">[KVK-NUMMER]</span>`, `.ph-blok`, "Foto volgt"-vlak). `test/site.test.mjs` bewaakt dat `data/site.json` leeg blijft; pas die test pas aan als er echte gegevens zijn.
- **AI-sfeerbeelden alleen eerlijk gemarkeerd** (besluit Bob, 3 okt 2026: "overal mooie foto's"). Alle beelden in `assets/beelden/` zijn AI-gegenereerd via KIE.AI en staan in `data/beelden.json` als `"soort": "sfeerbeeld"`; hun alt-tekst begint met "Sfeerbeeld"; op plekken waar ze als project gelezen kunnen worden (projectkaarten, projectpagina) staat het zichtbare label "Sfeerbeeld" (`.foto--sfeer`) en onder de voor/na de toelichting "Sfeerbeelden ter illustratie". Presenteer ze nooit als werk van De Koning, verzin er geen klant, plaats of case bij, en vervang ze vóór livegang door echte projectfoto's (of laat ze alleen staan als algemeen sfeerbeeld). Geen stockfoto's.
- **Geen review-structured data** (`Review`/`AggregateRating`), ook niet als er reviews zijn (besluit Bob). LocalBusiness-JSON-LD pas als adres, telefoon en KvK echt bekend zijn.
- **Geen inline `style`-attributen en geen inline scripts**: de preview draait met een strikte CSP (`deploy/preview.dekoningtegelwerken.nl.conf`). Varianten via klassen of data-attributen; dynamische waarden via `element.style.setProperty` in JS.
- **Geen AI-terminologie richting de bezoeker** (§32).
- Werk per fase op een featurebranch; nooit naar `main` pushen of mergen, dat doet Bob. `systemctl` en nginx herladen zijn voor Bob.

## Lokaal draaien en testen

```bash
python3 -m http.server 8099 --bind 127.0.0.1     # site op http://127.0.0.1:8099
node service/cli/genereer.mjs                    # na elke wijziging in data/ of _sjablonen/
node --test test/*.test.mjs                      # statische controles (zonder browser)
```

Browsertests met de headless Chromium die al op hfd-web01 staat (niets installeren):

```bash
export CHROME=$(ls -d ~/.cache/ms-playwright/chromium_headless_shell-*/*/ | head -1)chrome-headless-shell
node test/interactie.mjs                         # menu, filters, details, slider, site.json-gedrag
node test/schermafdruk.mjs /tmp/schermafdrukken  # afdrukken op 360/390/820/1440 px + overflowcontrole
```

## Architectuur

- **Generator in plaats van build-step** (`service/cli/genereer.mjs`). De uitvoer is gewone HTML die in de repo staat; de site werkt zonder het script te draaien. Het script:
  - maakt `projecten/<slug>/index.html` uit `_sjablonen/project.html` + `data/projecten.json` (alleen `pagina: true`) en de dienstpagina's (`/badkamer-tegelen/` enz.) uit `_sjablonen/dienst.html` + `data/diensten.json`; die bestanden **niet met de hand bewerken**;
  - vervangt in élke pagina de gebieden tussen `<!-- gen:x -->` en `<!-- /gen:x -->`: `head`, `header` (optie `over-hero` voor de homepage), `footer`, `werkwijze`, `eind`, `dienstkaarten`, `projecten uitgelicht|alle|categorie=<c> [filters]`. Handwerk binnen zo'n gebied verdwijnt bij de volgende run. Header, footer, werkwijze en eindsectie wijzig je in `_sjablonen/`;
  - markeert de actieve pagina in de navigatie (`aria-current="page"`; op dienstpagina's ook `.nav-groep.actief`) en schrijft `sitemap.xml` (zonder `noindex`-pagina's);
  - `--controleer` schrijft niets en faalt als de bestanden niet bij data/sjablonen passen (gebruikt door de test en het deploy-script).
  In stap 4 (beheer) gaat dezelfde logica de projectfragmenten naar een generatiemap buiten de werkkopie schrijven (plan §1.7).
- **Bedrijfsgegevens via `data/site.json`**, ingevuld door `js/site.js` (`initSiteGegevens`). Markup-afspraken:
  - `data-veld="telefoon|email|whatsapp|werkgebied|kvk|adres|btwId|googleProfielUrl"` op het element dat de waarde krijgt; op een `<a>` wordt ook `href` gezet (`tel:`, `mailto:`, `https://wa.me/<nummer>?text=<whatsappTekst>`). Met `data-veld-tekst` blijft de linktekst staan en wordt alleen `href` gezet.
  - `data-ph="<veld>"`: losse placeholder die verdwijnt zodra het veld gevuld is.
  - `data-veld-blok="<veld>"`: het blok dat in productiemodus (`placeholdersTonen: false`) verdwijnt als het veld leeg is.
  - Vertrouwenselementen in de hero (`[data-vertrouwen]`) worden **altijd** weggelaten als ze leeg zijn; jaren ervaring telt rustig op bij in beeld komen. Reviews (`[data-reviews-sectie]`) tonen de placeholder "Echte Google-reviews volgen" tot er echte reviews in `site.json` staan; in productiemodus zonder reviews verdwijnt de sectie.
- **Projecten** (`data/projecten.json`): `categorieen` voedt de filters (badkamer, vloer, toilet, xxl, visgraat, natuursteen). Het grid is asymmetrisch via `data-vorm` (groot, staand, staand-hoog, groot-laag, breed); `vormen()` staat **dubbel**, in `service/cli/genereer.mjs` en `js/site.js` — wijzig ze samen. Na filteren verdeelt JS de vormen opnieuw over de zichtbare kaarten.
- **Mobiel leidend** (390 px is de ontwerpbreedte): koppen 38–44 px op mobiel (`--t-kop-1/2`), lopende tekst minimaal 16 px, alles wat je aantikt minimaal 48 px (`--tik`), nergens horizontaal scrollen. Mobiele header = logo links, menuknop (icoon) rechts; onderin de sticky actiebalk (`.stickycta`) met WhatsApp (verdwijnt in productiemodus zonder nummer) en Offerte aanvragen. Specialismen zijn op mobiel compacte rijen zonder toelichting.
- **Homepage-volgorde**: hero → vertrouwenspunten (`.usps`, alleen door Bob bevestigde punten: persoonlijk contact, strakke afwerking, duidelijke afspraken; geen "specialist in XXL") → projecten → specialismen → vakmanschap/details → voor/na → werkwijze → reviews (score + max. 3) → over De Koning → contact-CTA.
- **Projectpagina**: foto's eerst (`fotos`: 6–12 beeld-id's, eerste groot, lichtbak via `[data-lichtbak]`), daarna tekst en vaste gegevens (Plaats uit `plaats`, dan `info`: Ruimte, Soort tegel, Formaat, Werkzaamheden, Bijzonderheden), details, voor/na.
- **Offertewizard** (`/offerte/`, `js/wizard.js`, keuzes in `data/wizard.json` → `<!-- gen:wizard -->`): zes stappen, vervolgvragen via `data-voor="<ruimte-id>"` (verborgen velden worden `disabled` en tellen niet mee), uploads blijven in de browser (miniaturen als data-URL, geen `blob:` i.v.m. de CSP), antwoorden in `sessionStorage`. Versturen alleen als het formulier `data-endpoint` heeft (stap 3); anders toont hij eerlijk de samenvatting met WhatsApp/e-mail/bellen uit `site.json` en "Kopieer samenvatting". Nooit iets als "verstuurd" tonen dat niet verstuurd is.
- **`data-alleen-preview`**: instructieblokken voor De Koning (zoals "kort verhaal van de eigenaar") die in productiemodus door `js/site.js` worden weggehaald.
- **JS** (`js/site.js`, één ES-module): elk onderdeel is element-geguard. `html.js` wordt in de module gezet; `.reveal` verbergt pas met `.js` en wat bij het laden al in beeld staat krijgt meteen `.in`, dus zonder JS is alles zichtbaar. Alle animatie staat uit bij `prefers-reduced-motion` (CSS én JS); behoud die fallbacks bij nieuwe animaties.
- **Beelden** (`data/beelden.json` → `assets/beelden/<id>-<breedte>.webp`): `service/cli/kie-beelden.mjs` genereert ontbrekende beelden via KIE.AI (`nano-banana-pro`, `POST /api/v1/jobs/createTask`, pollen via `/api/v1/jobs/recordInfo`), downloadt de ruwe JPEG naar `$KIE_RUW` (standaard `/tmp/dekoning-kie-ruw`, buiten de repo) en maakt met `cwebp` de breedtes uit het manifest; `--webp` zet alleen opnieuw om. De sleutel staat in `/etc/dekoning/kie.env` (`set -a; . /etc/dekoning/kie.env; set +a`) en komt nooit in de repo, logs of uitvoer. In de HTML komen beelden alleen via de generator: `beeld(id, {maat, …})` in sjablonen en `<!-- gen:beeld id=… maat=… -->` / `<!-- gen:voorna voor=… na=… -->` in handgeschreven pagina's; `sizes` per plek staat in `MATEN` in de generator. Ontbreekt een beeld (geen WebP-bestanden), dan valt de generator terug op het placeholdervlak met de alt-tekst als beschrijving, dus nooit een 404.
- **Dienstpagina's** (`data/diensten.json`) bevatten conceptteksten over wat er bij elk soort tegelwerk komt kijken, zonder bedrijfsclaims. De Koning moet ze nog controleren.

## Huisstijl

Tokens bovenaan `css/site.css` (één stylesheet voor de hele site, mobile first; breakpoints 40em, 60em, 64em voor de navigatie, 75em):

- Kleur: `--zand #f3eee6` (achtergrond), `--zand-diep #e8e0d3` (afwisselende sectie), `--kalk #fbf8f3` (kaarten), `--antraciet #1e1d1b` (tekst en donkere secties, klasse `.donker`), `--inkt-zacht #5f594f`, `--licht`/`--licht-zacht` op donker, accent **gedempt brons** `--brons #7d5f3c` (op licht) en `--brons-licht #c9a97f` (op donker). Geen losse hexwaarden in componenten; geen felle kleuren of gradients (alleen de rustige verduistering over foto's).
- Typografie, zelf gehost in `assets/fonts/` (OFL): **Instrument Serif** voor koppen, **Manrope** (variabel) voor tekst en interface. Geen verzoeken naar Google Fonts.
- Afgeronde hoeken alleen waar functioneel (`--hoek: 2px` op knoppen; filters en verwante links als pil). Dunne lijnen (`--lijn`), veel witruimte.
- Iconen: SVG-sprite `assets/iconen/iconen.svg` (`<use href="/assets/iconen/iconen.svg#naam"/>`), geen emoji.
- **Logo** (`assets/brand/logo.svg`, ruitvormig met kroon; paars #551B6B/#4D0E4F en zwart): opgeschoonde versie van het bestand op versvanzee.nl (zie `docs/GEHEUGEN.md`), nog geen officieel bronbestand. `logo-licht.svg` is dezelfde vorm in `--licht` voor donkere achtergronden (alleen kleuren gewijzigd; de rasterkroon via een kleurfilter). Gebruik: lichte variant in de header boven de hero (alleen op de homepage geladen) en in de footer, het origineel in de compacte header en het mobiele menu; maat via `--logo-h`. Altijd `alt="De Koning Tegelwerken"`, link naar `/`. Favicon en `apple-touch-icon.png` zijn de vectorkroon uit het logo op zand; `og-image.jpg` (1200×630) combineert het hero-sfeerbeeld met de lichte logovariant. Het logopaars wijkt af van het brons-accent van de site; daar is nog geen besluit over.
- Beelden: WebP in meerdere breedtes, `width`/`height` altijd gezet, `fetchpriority="high"` alleen voor het beeld in de eerste viewport, de rest `loading="lazy"`. Hero op mobiel onder ongeveer 150 KB.
