# Geheugen — stand van zaken dekoningtegelwerken.nl

Bijgewerkt: 5 oktober 2026. Live: 1b, wizard, 1c, de logo/slider-fix, de mobiele
hero, het lettertype, de mobiele polish en de leesbaarheid van de hero-kop
(`main` = 8802784; de laatste sitewijziging daarin is 5edaacf).
Werk dit bestand bij aan het eind van elke fase.

> **Naast de website loopt sinds 5 oktober 2026 een tweede spoor:** het interne
> **factuurdashboard** op `feature/factuurdashboard`, sinds 9 oktober uitgebreid
> tot **portaal met mailsorteerder** op `feature/mailsorteerder-portaal`. Dat
> heeft niets met de publieke site te maken en staat onderaan dit bestand
> beschreven.

## Waar staan we

| Fase / stap | Status |
|---|---|
| A — inventaris en plan | Klaar, goedgekeurd door Bob op 3 okt 2026. Besluiten staan bovenaan `docs/PLAN.md`. |
| B — stap 1: design system, homepage, projecten, diensten, contact | Klaar; op uitdrukkelijk besluit van Bob via `main` live gezet (zie "Live sinds"). |
| B+ — sfeerbeelden en logo | Klaar op dezelfde branch: 29 AI-sfeerbeelden overal waar placeholdervlakken stonden, en het logo in header, menu, footer, favicon en og-image. |
| 1b — mobiel leidend (feedback Bob, 3 okt 2026) | Klaar op `feature/fase-1b-mobiel`: 390 px als ontwerpbreedte, koppen 38–44 px, klikvlakken ≥ 48 px, header = logo + menuknop, sticky balk WhatsApp + Offerte, nieuwe hero (specialismen, "Vakwerk in IJmuiden en omgeving."), drie bevestigde vertrouwenspunten, compacte specialismen op mobiel, projectpagina met galerij (6–12) en lichtbak, reviewscore. Op de preview; op akkoord van Bob (4 okt 2026) in `main` (de2ce63), **live sinds 4 okt 2026** (uitgerold door Bob). |
| 1c — mobiele verfijning (feedback Bob, 4 okt 2026) | Klaar op `feature/fase-1c-mobiel`: header 72 px, menu met offerte bovenaan en uitklapbare diensten, hero 78svh, h1 38–42 px op mobiel, swipebare filters en reviews, specialismen één per rij met groot beeld, vakmanschap als grote close-up met vegen, balk weg tijdens invullen, wizard: telefoon óf e-mail. Werkwijze houdt de stappen uit de briefing (zie open vraag). **Live sinds 4 okt 2026.** |
| Mobiele hero (feedback Bob, 4 okt 2026) | `feature/mobiele-hero`: compactere hero (± 74svh), groter logo (69 px) in dezelfde header, h1 44–46 px, lichtere overlay bovenin, één dominante knop + tekstlink, dunne trust-balk; projectkop en eerste foto al in het eerste scherm op 390 px. **Live sinds 4 okt 2026** (`main` = 886424e). |
| Lettertype (4 okt 2026) | `feature/lettertype`: Fraunces (koppen) + Inter (tekst) in plaats van Instrument Serif + Manrope; og-image opnieuw gemaakt met de nieuwe hero, het paarse logo en Fraunces. **Live sinds 4 okt 2026** (`main` = fb98311). |
| Mobiele polish (4 okt 2026) | `feature/mobiele-polish` (bovenop lettertype): heroblok ± 40 px hoger, werkgebied 88% wit, offerteknop 50 px met 17 px tekst (16 px op 360), trust-balk op één regel met korte labels (Persoonlijk / Strak afgewerkt / Duidelijk; volledige titel voor schermlezers), specialismen op 360 px op één regel. **Live sinds 4 okt 2026** (`main` = fb98311). |
| Leesbaarheid hero-kop (4 okt 2026) | `feature/hero-leesbaarheid`: verduistering op de plek van de kop (mobiel verticaal vanaf ± 18%, desktop vanaf links) en kop op gewicht 440. Contrast onder de letters van ± 3:1 (slechtste plek 1,3–2,1) naar 6,4–8:1 (slechtste plek ≥ 3,9). **Live sinds 4 okt 2026** (`main` = 5edaacf). |
| Stap 2 — offertewizard `/offerte` | Klaar op `feature/fase-2-offertewizard` (bovenop 1b): zes stappen uit `data/wizard.json` (ruimte → oppervlak → tegels → foto's → plattegrond → contact), vervolgvragen per ruimte, lengte × breedte, uploads met miniaturen, sessionStorage, samenvatting in het formaat "Nieuwe aanvraag – Badkamer, 1971 RA / Badkamer: vloer ±8 m², wanden ±31 m² · Inloopdouche …". **Zonder backend verstuurt hij niets**: de bezoeker krijgt de samenvatting om via WhatsApp/e-mail door te sturen of te kopiëren. Op de preview; in `main` (de2ce63), **live sinds 4 okt 2026** (uitgerold door Bob). |
| Stap 3 — backend | Niet begonnen. De wizard is er klaar voor: `data-endpoint` op het formulier zetten, dan gaan antwoorden + bestanden als multipart naar die URL. |
| Stap 4 — beheer, calculatie, offertes, project-CMS | Niet begonnen. |
| Stap 5 — plattegrondanalyse, AI-conceptcalculatie | Niet begonnen. |

## Wat er in stap 1 is gebouwd

- **Design system** in `css/site.css`: zand/antraciet/brons, Fraunces + Inter (zelf gehost, sinds 4 okt 2026; eerst Instrument Serif + Manrope), dunne lijnen, ruime witruimte, placeholdervlakken met een fijn voegenraster.
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

- **Nieuwe hero (4 okt 2026, op verzoek van Bob):** badkamer met XXL-platen in warme travertinlook en een vrijstaand bad; `hero` (16:9) en `hero-mobiel` (4:5, met `hero` als referentie voor dezelfde ruimte) opnieuw gemaakt, 2 generaties, 36 credits. Totaal nu 32 generaties.
- **29 beelden**, AI-gegenereerd via KIE.AI met `nano-banana-pro` (2K, `POST /api/v1/jobs/createTask`, pollen via `/api/v1/jobs/recordInfo`). 30 generaties in totaal: een eerste run op de achtergrond werd afgebroken (één taak ging daarbij verloren), daarna op de voorgrond in twee parallelle brokken. Geen enkel beeld mislukt. Verbruik 540 credits (18 per beeld); tegoed daarna 8453.
- Manifest met prompts, verhoudingen, breedtes en alt-teksten: `data/beelden.json`; script: `service/cli/kie-beelden.mjs` (sleutel uit `/etc/dekoning/kie.env`, nooit in repo of logs). Het na-beeld van de voor/na is een image-to-image-bewerking van het voor-beeld (zelfde standpunt).
- WebP via `cwebp` (q78) in 3 à 4 breedtes: 93 bestanden, samen 2,8 MB voor álle varianten; een bezoeker laadt alleen de passende breedte. Hero op mobiel 13 KB (800 px), hero desktop 43 KB (2400 px).
- **Eerlijkheid:** elk beeld is `"soort": "sfeerbeeld"`, elke alt-tekst begint met "Sfeerbeeld", projectbeelden dragen zichtbaar het label "Sfeerbeeld", onder de voor/na staat "Sfeerbeelden ter illustratie, geen werk van De Koning Tegelwerken". Voorbeeldprojecten houden placeholdernamen (geen klanten, plaatsen of cases).
- **Vóór livegang:** alle sfeerbeelden vervangen door echte projectfoto's van De Koning, of alleen laten staan waar ze niet als eigen werk worden gepresenteerd (bijv. algemeen sfeerbeeld bij een dienst). Vastgelegd in `docs/PLAN.md` (besluiten).

## Logo (3 oktober 2026)

- Bron: `https://versvanzee.nl/padel-sponsors/de-koning-tegelwerken.svg` (sponsorlogo op de site van Vers van Zee). Die URL zit achter een Cloudflare-controle (403 voor curl); het bestand is daarom **alleen-lezend van vps1** gehaald (`/home/versvanzee-vps1/live-storefront/public/padel-sponsors/`). Het is byte-gelijk aan `De_Koning_Tegelwerken_LOGO_DEF.svg` in de WordPress-uploads van staging.versvanzee.nl, een Illustrator-export.
- Inhoud: ruit (tegel op de punt), "DE KONING" als paden in paars (#551B6B/#4D0E4F), zwarte onderhelft met "TEGELWERKEN" uitgespaard, kroon als **ingebed JPEG** (data-URI, met vectorknippad). Geen scripts, events of externe verwijzingen.
- `assets/brand/logo.svg`: opgeschoond (geen `<style>` of `style`-attributen, strakke viewBox 542×442). **Overal het paarse origineel** (besluit Bob, 4 okt 2026); de lichte variant `logo-licht.svg` is verwijderd. Boven de hero heeft de header daarom een lichte achtergrond, in de footer staat het logo op een lichte tegel.
- Favicon (`assets/favicon.svg`) en `assets/apple-touch-icon.png` (180 px): het vectorpad van de kroon uit het logo in het logopaars op zand, dus een uitsnede en geen nieuw merk. `assets/og-image.jpg` (1200×630): hero-sfeerbeeld met de lichte logovariant en "Tegelwerk tot in detail.".
- **Nog nodig van De Koning:** een officieel bronbestand van het logo (SVG of AI, liefst met de kroon als vector in plaats van een ingebed JPEG), en een besluit of het logopaars ook als accentkleur op de site moet komen (nu gedempt brons).

## Live sinds 3 oktober 2026

Op uitdrukkelijk besluit van Bob staat de site live op **https://dekoningtegelwerken.nl/** (www stuurt door), vóórdat alles klaar was. `main` is daarvoor fast-forward gezet naar de featurebranch (85a2e6d), certificaat via certbot (webroot `/var/www/html`, beide namen), vhost `/etc/nginx/sites-enabled/dekoningtegelwerken.nl.conf` = `deploy/dekoningtegelwerken.nl.conf`, root `/var/www/dekoningtegelwerken`, uitgerold met `deploy/live-deploy.sh --forceer`.

Open punten die nu **openbaar** zichtbaar zijn (de voorcontrole blijft ze melden):
- `placeholdersTonen: false`, dus zonder telefoon, e-mail, WhatsApp en werkgebied staat er op de site geen enkele contactmogelijkheid; alleen het KvK-nummer.
- 6 voorbeeldprojecten (met `[PROJECTNAAM]`/`[PLAATS]`) en sfeerbeelden met het label "Sfeerbeeld" op projectkaarten en de projectpagina.
- Dienstteksten nog niet door De Koning gecontroleerd.

Bijwerken: wijziging mergen naar `main` én de lokale `main` op de server bijwerken (`git branch -f main origin/main`; het script pakt de lokale branch), daarna `deploy/live-deploy.sh` (met `--forceer` zolang bovenstaande open staat).

## Preview

Preview zichtbaar maken: stappen in `deploy/README.md` (DNS-record `preview`, map, wachtwoordbestand, certificaat, vhost, `deploy/preview-deploy.sh feature/fase-1-frontend`). Daarna beoordelen en eventueel mergen. Bijwerken na nieuwe commits:

```bash
cd /root/dekoning-tegelwerken && deploy/preview-deploy.sh feature/fase-1-frontend
```

## Wizard live zetten: eerst één ontvangstkanaal

Zonder backend én zonder WhatsApp-nummer, e-mailadres of telefoon in `data/site.json` eindigt de wizard op de live site bij "Kopieer samenvatting": er is dan geen plek om de aanvraag heen te sturen. Vóór de wizard live gaat minimaal één van: e-mailadres of WhatsApp-nummer in `site.json`, of stap 3 (aanvraagdienst, `data-endpoint`).

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

---

# Factuurdashboard (intern, los van de website)

Opdracht van Bob, 5 oktober 2026, ongewijzigd vastgelegd in
[`docs/opdrachten/factuurdashboard.md`](opdrachten/factuurdashboard.md), met
onderaan zijn antwoorden op de open vragen uit fase A.

**Branch:** `feature/factuurdashboard` (vanaf `origin/main` = 8802784). Niet
gemerged; mergen doet Bob. Vier commits:

1. Opdracht factuurdashboard vastleggen
2. Kern van het factuurdashboard: opslag, koppelingen en de sync-ronde
3. Schermen en dienst van het factuurdashboard, met tests
4. Uitrol van het factuurdashboard voorbereiden

## Wat het doet

Een dependency-vrije Node 22-dienst die de map **Inbox › Facturen** van de
Microsoft 365-mailbox uitleest, de facturen met de Claude API laat uitlezen, ze
koppelt aan uitgaande bunq-betalingen en betaalde facturen naar de boekhouder
doorstuurt. Drie schermen: overzicht, één factuur behandelen, instellingen.

Het staat **niet** op de website: `127.0.0.1:8132`, alleen via het tailnet
(`tailscale serve --set-path /facturen`), met Basic Auth erbovenop. Geen
nginx-vhost, niets open naar buiten.

## Opbouw

| Map/bestand | Wat |
|---|---|
| `service/facturen/server.mjs` | De dienst: routes, Basic Auth, CSP, statische bestanden, de timer. |
| `service/facturen/lib/` | `db` (schema + queries), `instellingen`, `http` (retry), `graph`, `claude`, `bunq`, `koppelen`, `doorsturen`, `sync`, `hulp`. |
| `service/facturen/web/` | De drie schermen (server-side HTML), `dashboard.css`, `dashboard.js`. |
| `test/facturen-*.test.mjs` | 83 tests in `node --test`, zonder netwerk. |
| `test/facturen-browser.mjs` | Browsertest: overflow, klikvlakken, bevestiging vóór doorsturen. |
| `deploy/` | Unit, env-voorbeeld, deploy-script, PowerShell-script, eigen README. |

Keuzes die vastliggen (besluiten van Bob, 5 okt 2026):

- poort **8132** (8130/8131 blijven gereserveerd voor `dekoning-aanvraag` en
  `dekoning-beheer` uit `docs/PLAN.md` §1.3);
- eigen gebruiker `dekoning-facturen`, data in `/var/lib/dekoning-facturen`,
  code in `/opt/dekoning-facturen` (de werkkopie staat onder `/root`, dat is
  0700 en dus onbereikbaar voor een dienstgebruiker);
- `BASIS_PAD` standaard leeg, in productie `/facturen`;
- bunq op **production**, alleen lezen;
- **geen** terugval bij een weigering van het model; die wordt afgevangen als
  `mislukt` en is in het dashboard opnieuw te proberen;
- genormaliseerde Levenshtein als gelijkenismaat voor leveranciersnamen (het
  Python-prototype gebruikte `difflib.SequenceMatcher`; grensgevallen rond 0,75
  kunnen daardoor anders uitvallen), plus een vaste tie-break bij het greedy
  toewijzen zodat de uitkomst reproduceerbaar is.

## Veiligheid en eerlijkheid

- Secrets staan alleen in `/etc/dekoning/facturen.env` (600) en komen niet in
  de repo, een logregel, het logboek of een pagina. De bunq-state (sleutelpaar,
  tokens) staat op 600 en bevat de API-key niet, alleen een hash ervan.
- **Testmodus staat standaard aan**: automatisch doorsturen wordt dan alleen
  gelogd. De knop op een factuur verstuurt wél altijd echt, na een bevestiging
  in de browser.
- De schakelaar "automatisch doorsturen" legt zijn eigen startmoment vast.
  Alleen facturen die dáárna betaald zijn gaan automatisch mee; oudere blijven
  onder "Nog naar boekhouder" staan en gaan alleen met de knop. Zonder die
  grens zou de eerste sync de hele historie naar de boekhouder sturen.
- Zonder e-mailadres van de boekhouder gaat er niets weg, ook niet met de knop;
  dat wordt in het scherm en in het logboek gemeld.
- Elke POST wordt op herkomst gecontroleerd (`Sec-Fetch-Site`, anders `Origin`
  tegen de `Host`), zodat een andere site geen actie kan laten uitvoeren met de
  inloggegevens die de browser al heeft.
- Een mail met meerdere PDF's gaat één keer de deur uit; de andere regels van
  die mail worden als meegestuurd gelogd, zodat ze niet als achterstand blijven
  staan.
- Niets wordt verzonnen: wat het model niet zeker weet blijft leeg, en een
  mislukt uitlezen is zichtbaar in plaats van stilletjes leeg.

## Getest

- `node --test test/*.test.mjs`: **94/94**, waarvan 11 de bestaande sitetests.
  Graph, bunq en Claude zijn nagebootst; er gaat geen verzoek naar buiten.
- `node test/facturen-browser.mjs`: **35/35** in de headless Chromium van
  hfd-web01 — geen horizontale overflow op 360/390/820/1440 px, klikvlakken
  ≥ 44 px, geen JS-fouten of mislukte verzoeken, en doorsturen vraagt eerst na.
- **Niet getest:** de echte koppelingen (Microsoft 365, bunq, Claude) en
  `deploy/Setup-MailboxScope.ps1` — op hfd-web01 staat geen PowerShell. Die
  gaan pas langs de werkelijkheid zodra Bob de env invult.

Tijdens het testen gevonden en opgelost: `€ 90,-` werd als negatief bedrag
gelezen; het bunq-pad werd opgebouwd vóór de sessie bestond; een gewisselde
bunq API-key werd niet opgemerkt zolang er nog een sessie lag; de
instellingenpagina liep op mobiel buiten beeld (een `fieldset` krimpt standaard
niet); de terug-link was op mobiel een te klein klikvlak.

## Wat Bob nog zelf moet doen

De volledige volgorde met commando's staat in
[`deploy/README-factuurdashboard.md`](../deploy/README-factuurdashboard.md).
Kort: Entra-app zonder Mail-permissions aanmaken, `Setup-MailboxScope.ps1` op
Windows draaien, een bunq API-key maken, op hfd-web01 de gebruiker en
`/etc/dekoning/facturen.env` aanmaken, `facturen-deploy.sh` draaien, de unit
installeren en starten, poort 8132 in `/etc/handsfree/poorten.md` zetten en
`tailscale serve --set-path /facturen` aanzetten. Daarna: eerst een paar rondes
in testmodus nakijken, en `/var/lib/dekoning-facturen` in de back-up opnemen.
De datamap zelf hoeft hij niet aan te maken: `StateDirectory` in de unit doet
dat op 0700.

---

# Portaal en mailsorteerder (9 oktober 2026)

Opdracht van Bob, ongewijzigd in
[`docs/opdrachten/mailsorteerder-portaal.md`](opdrachten/mailsorteerder-portaal.md),
met onderaan zijn antwoorden en correcties bij de go voor fase B.

**Branch:** `feature/mailsorteerder-portaal`, vanaf `feature/factuurdashboard`
(9089913). Niet gemerged; mergen doet Bob.

## Stand per fase

- **Fase 0 (klaar):** het factuurdashboard draait sinds 9 okt op hfd-web01:
  gebruiker `dekoning-facturen`, poort 8132 in `/etc/handsfree/poorten.md`,
  code `feature/factuurdashboard` (9089913) in `/opt/dekoning-facturen`, unit
  enabled. Alleen lokaal, Basic Auth (gebruiker `bob`). Na de RBAC-fix van Bob:
  verbindingstest Microsoft 365 in orde (map Facturen gevonden in
  info@dekoningtegelwerken.nl); eerste ronde 10 mails, 11 PDF's ingelezen,
  **niets doorgestuurd** (geen boekhouderadres, testmodus aan). De draaiende
  dienst kent de `ANTHROPIC_API_KEY` pas na een herstart (die hoort bij fase C).
- **Fase A (klaar):** inventaris en plan, akkoord van Bob met correcties.
- **Fase B (klaar):** gebouwd, getest en gepusht; het systeem is niet
  aangeraakt (alleen een alleen-lezen controle van de delta query op de
  mailbox en een `--droog` van het deploy-script).
- **Fase C (stap 1–6 klaar, 9 okt 2026, 16:20–16:30 CEST):** DNS `cms` →
  178.104.144.203 (bij Namecheap; het domein staat níet bij Cloudflare, al
  heeft Bob daar ook records). Certificaat tot 7 jan 2027 (certbot, webroot).
  Env aangevuld met `GRAPH_WEBHOOK_SECRET` en `OFFERTES_URL` (back-up ernaast,
  600). Versie ec325f2 in `/opt/dekoning-facturen`, unit bijgewerkt, dienst
  herstart: SSO aan, schema 2. Vhost `cms.dekoningtegelwerken.nl.conf` in
  sites-enabled, fail2ban-jail `dekoning-cms` actief. Van buitenaf: http→https,
  `/`→`/auth/login`→Microsoft, `/auth/check` 401, `/graph/notify` met fout
  geheim 401, HSTS/CSP/noindex aanwezig. Sorteerder: startpunt 14:20 UTC,
  mappen `Klanten & projecten`, `Leveranciers`, `Nieuwsbrieven & reclame`
  aangemaakt (14:24), webhook-subscription `d5ebf7c7-…` geldig tot 12 okt
  (de eerste poging om 14:20 faalde nog omdat 443 toen niet bestond).
  **Stap 7 open:** Bob kan niet inloggen als info@ (geen toegang tot die MFA).
  Geen bypass bouwen; oplossing: zijn beheerdersaccount toewijzen op de
  enterprise app én toevoegen aan `PORTAL_ALLOWED_EMAILS` (daarna herstart).
  Wacht op het adres. Eerste gesorteerde mail nog niet gezien.

## Mailtoegang (besluit Bob, 9 okt 2026)

De mail-app (`dcab51df-…`) heeft Application `Mail.ReadWrite` + `Mail.Send`
**alleen via Exchange RBAC for Applications**, scope `Scope-FactuurdashboardDKT`
op info@dekoningtegelwerken.nl (getest: InScope True voor DKT, False voor
andere mailboxen). In Entra staan **geen** Mail-rechten. De tenant wordt
gedeeld met andere mailboxen en domeinen van Bob en klanten: **toegang via
RBAC-scope op één mailbox; nooit Entra Mail-rechten toevoegen.** Met RBAC
staat er geen roles-claim in het token; "Verbindingen testen" kijkt echt in de
mailbox. Dezelfde app leest de facturen, sorteert en stuurt door.

## Opbouw

Eén dienst (`service/facturen/`, unit `dekoning-facturen`, 127.0.0.1:8132):

| Pad | Wat |
|---|---|
| `/` | startpagina: tegels Facturen (open/verlopen), Mail (vandaag gesorteerd, te controleren), Offertes (link naar de Offerteknop-tenant met eigen login) |
| `/facturen/` | het factuurdashboard (`maakFacturenApp` in `server.mjs`) |
| `/mail/` | logboek met filters, Terugzetten, Andere map (met "altijd" → regel); `/mail/regels`; `/mail/instellingen` (`mail.mjs`, `web/mail.mjs`) |
| `/auth/*` | login, callback, logout, uitgelogd, check (`portaal.mjs`) |
| `/graph/notify` | webhook van Graph, zonder login |

| Bestand | Wat |
|---|---|
| `lib/mail/koppeling.mjs` | de vaste mailinterface (`nieuweBerichten`, `verplaats`, `categorie`, `doorsturen`, `mapAanmaken` + ondersteunend), gekozen op `MAIL_PROVIDER`; nu alleen `m365` (`lib/mail/m365.mjs`). Een Gmail-adapter komt ernaast zonder verbouwing. |
| `lib/graph.mjs` | uitgebreid met delta query op de Inbox, move, mappen onder Inbox, subscriptions |
| `lib/sorteren.mjs` | de sorteerder; `lib/classificeer.mjs` (Claude, `SORT_MODEL`); `lib/sorteer-opslag.mjs`; `lib/webhook.mjs` |
| `lib/oidc.mjs`, `lib/sessies.mjs` | Entra-login en sessies |
| `lib/web.mjs`, `web/statisch.mjs` | gedeelde http-hulp en statische bestanden |
| `deploy/nginx/`, `deploy/fail2ban/`, `deploy/CMS-INSTALLATIE.md` | fase C |

Schema versie 2: `sorteer_log`, `sorteer_regels`, `sorteer_staat`, `sessies`,
`oidc_pogingen` (alleen nieuwe tabellen).

## Hoe de sorteerder beslist

1. Eerste ronde: alleen een startpunt (deltaLink met filter op
   `receivedDateTime ge nu`); bestaande inboxmail wordt nooit gesorteerd. Een
   verlopen deltaLink (410) geeft een nieuw startpunt.
2. Overslaan: agenda (`eventMessage`), gemarkeerd, concept, de eigen mailbox,
   het eigen domein (behalve een adres dat Bob zelf als adresregel of
   website-afzender opgaf). Ook overgeslagen: een mail die al eens langs is
   geweest (herkend aan `internetMessageId`, dus ook na terugzetten) en een
   oude mail die alleen gewijzigd is.
3. Regels uit de database (adres wint van domein, subdomeinen tellen mee;
   een regel kan ook "Inbox" zijn = laten staan) → website-afzenders
   (instelling, standaard leeg; Bob vult die later) naar `Offerteaanvragen`
   zonder AI → Claude met afzender, onderwerp, 1500 tekens en bijlagenamen.
   Het antwoord telt alleen als het een bestaande map is met een zekerheid
   tussen 0 en 1.
4. Claude ≥ drempel (0,75) → verplaatsen, nieuw id bewaren; daaronder categorie
   `Controleren`. Map uit → blijft staan. Fout → blijft staan, in het logboek.
   Zonder Claude-sleutel → "niet beoordeeld", blijft staan.
5. Eén ronde tegelijk; een seintje tijdens een ronde geeft precies één
   vervolgronde. Polling elke `SORT_INTERVAL_MIN` (5); de webhook alleen als SSO
   aan staat, `PORTAL_BASE_URL` en `GRAPH_WEBHOOK_SECRET` gevuld zijn. De
   subscription loopt 3 dagen en wordt verlengd als er minder dan een dag over
   is; validationToken wordt alleen beantwoord tijdens het aanmaken.

## Inloggen

- SSO staat pas aan als `PORTAL_BASE_URL` (https), tenant-GUID,
  `ENTRA_PORTAL_CLIENT_ID`, `ENTRA_PORTAL_CLIENT_SECRET`,
  `PORTAL_ALLOWED_EMAILS` en `SESSION_SECRET` (≥ 32) er allemaal zijn; anders
  Basic Auth (alleen lokaal). De journal zegt bij de start welke het is.
- OIDC code + PKCE (S256), state (eenmalig, 10 min, gebonden aan een
  `__Host-dkt_login`-cookie) en nonce. id_token zelf gecontroleerd: RS256 tegen
  de JWKS van de tenant (cache 24 uur, onbekende kid hooguit eens per 5 min
  opnieuw), iss, aud, tid, exp/nbf (2 min marge), nonce. Daarna de allowlist
  op `preferred_username`/`email`; leeg = niemand.
- Sessie in SQLite (alleen een HMAC van het token), cookie `__Host-dkt_sessie`,
  Secure, HttpOnly, SameSite=Lax, 8 uur schuivend. CSRF-token per sessie in
  elk POST-formulier (ook uitloggen), naast de herkomstcontrole.
- `form-action` in de CSP staat ook `login.microsoftonline.com` toe: uitloggen
  eindigt met een redirect naar de logout van Microsoft.
- Offerteknop blijft ongewijzigd (besluit Bob): de tegel linkt naar de tenant
  met zijn eigen login. Het platformbrede SSO-geheim van Offerteknop komt niet
  naar cms. Het `auth_request`-blok voor `/offertes/` staat uitgecommentarieerd
  in de vhost, klaar voor als Offerteknop `X-Portal-User` vertrouwt.

## Getest (9 okt 2026)

- `node --test test/*.test.mjs`: **181/181** (11 site, 83 facturen, 87 nieuw:
  mailinterface, sorteren, webhook, OIDC/sessies, portaal over http). Graph,
  Claude en Entra nagebootst; Entra met eigen RSA-sleutels en JWKS.
- `node test/portaal-browser.mjs`: **33/33**; `node test/facturen-browser.mjs`:
  **35/35**. `test/cdp.mjs` start Chromium nu via `timeout -k 5`.
- `nginx -t` op een losse kopie van de vhost (met het bestaande certificaat
  ingevuld); `fail2ban-regex` op voorbeeldregels; een proefstart van de nieuwe
  dienst op een vrije poort met lege env (Basic Auth, alle pagina's 200).
- Alleen-lezen tegen de echte mailbox: delta query met filter en vervolgronde,
  submappen van de Inbox (nu alleen `Facturen`). `claude-haiku-4-5` antwoordt
  200 bij de API.
- **Niet getest:** een echte Entra-login, een echte webhook-subscription en een
  echte move; die komen in fase C.

## Niet gebouwd

- De optionele knop "Bestaande inbox sorteren" (eerst tellen, dan bevestigen).
- Een echte één-login voor het offertebeheer (volgt in de Offerteknop-repo).

## Open voor Bob

Entra `DKT Portaal` aanmaken (stap 3 van `CMS-INSTALLATIE.md`), DNS voor
`cms.`, akkoord voor fase C (inclusief fail2ban), website-afzenders invullen
zodra bekend, bunq-sleutel, boekhouderadres, back-up van
`/var/lib/dekoning-facturen`. Verder AVG: mailinhoud (1500 tekens) gaat naar
Anthropic als er geen regel past.

