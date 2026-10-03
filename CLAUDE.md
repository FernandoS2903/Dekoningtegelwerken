# CLAUDE.md

Richtlijnen voor Claude Code (claude.ai/code) bij werk in deze repository.

## Project

Website **dekoningtegelwerken.nl** voor De Koning Tegelwerken, gebouwd door Handsfree Digital. De briefing staat ongewijzigd in `docs/opdrachten/dekoning-website.md` (§-nummers in comments en docs verwijzen daarnaar), het plan met de fasering en de besluiten van Bob in `docs/PLAN.md`, de actuele stand in `docs/GEHEUGEN.md`. Lees die drie voordat je aan een nieuwe fase begint.

Statische site met één ontwerpsysteem. **Bewust geen frameworks, geen build-step en geen npm-dependencies**: introduceer geen bundlers, preprocessors of packages. Backenddiensten (latere fasen) worden dependency-vrije Node 22-diensten (`node:http`, `node:sqlite`), naar het patroon van `/root/handsfree-digital-werk/service/`.

Alle zichtbare tekst, comments, documentatie en commitberichten zijn **Nederlands**.

## Harde regels

- **Verzin niets.** Geen bedrijfsgegevens, reviews, aantallen, jaren ervaring of prijzen die niet door Bob/De Koning zijn aangeleverd. Ontbreekt iets, dan een herkenbare placeholder (`<span class="ph">[KVK-NUMMER]</span>`, `.ph-blok`, "Foto volgt"-vlak). `test/site.test.mjs` bewaakt dat `data/site.json` leeg blijft; pas die test pas aan als er echte gegevens zijn.
- **Geen stock- of AI-beeld als projectfoto.** Tot er echte foto's zijn: placeholdervlakken met een beschrijvend `aria-label` ("Placeholder, beoogde foto: …").
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
node test/schermafdruk.mjs /tmp/schermafdrukken  # afdrukken op 360/820/1440 px + overflowcontrole
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
- **JS** (`js/site.js`, één ES-module): elk onderdeel is element-geguard. `html.js` wordt in de module gezet; `.reveal` verbergt pas met `.js` en wat bij het laden al in beeld staat krijgt meteen `.in`, dus zonder JS is alles zichtbaar. Alle animatie staat uit bij `prefers-reduced-motion` (CSS én JS); behoud die fallbacks bij nieuwe animaties.
- **Dienstpagina's** (`data/diensten.json`) bevatten conceptteksten over wat er bij elk soort tegelwerk komt kijken, zonder bedrijfsclaims. De Koning moet ze nog controleren.

## Huisstijl

Tokens bovenaan `css/site.css` (één stylesheet voor de hele site, mobile first; breakpoints 40em, 60em, 64em voor de navigatie, 75em):

- Kleur: `--zand #f3eee6` (achtergrond), `--zand-diep #e8e0d3` (afwisselende sectie), `--kalk #fbf8f3` (kaarten), `--antraciet #1e1d1b` (tekst en donkere secties, klasse `.donker`), `--inkt-zacht #5f594f`, `--licht`/`--licht-zacht` op donker, accent **gedempt brons** `--brons #7d5f3c` (op licht) en `--brons-licht #c9a97f` (op donker). Geen losse hexwaarden in componenten; geen felle kleuren of gradients (alleen de rustige verduistering over foto's).
- Typografie, zelf gehost in `assets/fonts/` (OFL): **Instrument Serif** voor koppen, **Manrope** (variabel) voor tekst en interface. Geen verzoeken naar Google Fonts.
- Afgeronde hoeken alleen waar functioneel (`--hoek: 2px` op knoppen; filters en verwante links als pil). Dunne lijnen (`--lijn`), veel witruimte.
- Iconen: SVG-sprite `assets/iconen/iconen.svg` (`<use href="/assets/iconen/iconen.svg#naam"/>`), geen emoji.
- Logo en favicon zijn **placeholders** (woordmerk in tekst, monogram K) tot het echte logo er is.
