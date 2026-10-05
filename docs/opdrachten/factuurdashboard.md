# Opdracht: factuurdashboard De Koning Tegelwerken

Opdrachtgever: Bob (Handsfree Digital). Datum: 5 oktober 2026.
Repo: `/root/dekoning-tegelwerken` op hfd-web01. Volg `CLAUDE.md` van deze repo: Nederlands, featurebranch, nooit `main` pushen of mergen, `systemctl`/nginx zijn voor Bob.

## Doel

De e-mail van De Koning Tegelwerken staat sinds kort in Microsoft 365. Inkomende facturen komen in de map **Inbox › Facturen** van zijn mailbox. Bouw een intern dashboard dat:

1. die facturen automatisch inleest (PDF-bijlagen, of de mailtekst als er geen PDF is);
2. met de Claude API de factuurgegevens eruit haalt;
3. de facturen koppelt aan uitgaande betalingen op zijn **bunq**-rekening;
4. een overzicht geeft (open, verlopen, betaald, nog naar de boekhouder) waarin je per factuur kunt **behandelen**: gegevens corrigeren, op betaald zetten, negeren, doorsturen;
5. betaalde facturen **doorstuurt naar de boekhouder**, handmatig met een knop én optioneel automatisch via een aan/uit-schakelaar in een instellingenpagina.

Er bestaat al een werkende Python/FastAPI-versie als prototype (niet op de server). Bouw dezelfde functionaliteit als **dependency-vrije Node 22-dienst** naar het patroon van `/root/handsfree-digital-werk/service/` (`node:http`, `node:sqlite`, ingebouwde `fetch` en `node:crypto`; geen npm, geen frameworks, geen build-step). De specificatie hieronder is leidend.

## Besluiten van Bob (staan vast)

- Draait op **hfd-web01**, luistert alleen op `127.0.0.1` (poort voorstellen die vrij is), bereikbaar via Tailscale (`tailscale serve`) en daarbovenop Basic Auth.
- **Microsoft Graph app-only** (client credentials), via Exchange **RBAC for Applications** beperkt tot één mailbox. Geen tenant-brede Mail-rechten in Entra.
- **Uitlezen met de Claude API** (direct `fetch` naar `https://api.anthropic.com/v1/messages`, `anthropic-version: 2023-06-01`, PDF als `document`-blok base64). Model instelbaar, standaard `claude-sonnet-5-5`.
- **Doorsturen instelbaar**: toggle "automatisch doorsturen zodra betaald" + altijd een handmatige knop.
- bunq-koppeling **alleen lezen**.
- Code in deze repo, op een featurebranch vanaf `origin/main`.

## Specificatie

### Configuratie (env-bestand buiten de repo, bv. `/etc/dekoning/facturen.env`, 600)
`M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_SECRET, M365_MAILBOX, M365_FOLDER` (standaard `Facturen`, pad onder Inbox, mag genest `Facturen/2026`), `ANTHROPIC_API_KEY, CLAUDE_MODEL`, `BUNQ_API_KEY, BUNQ_ENV` (production|sandbox), `BUNQ_ACCOUNT_IBANS` (optioneel filter), `DASHBOARD_USER, DASHBOARD_PASSWORD, SYNC_INTERVAL_MIN` (standaard 15), `DATA_DIR`. Ontbrekende koppelingen slaan hun stap over in plaats van te crashen. Secrets nooit in repo, logs of uitvoer.

### Data (SQLite in `DATA_DIR`, PDF's in `DATA_DIR/pdfs`, buiten de werkkopie)
- `facturen`: message_id + attachment_id (uniek samen; `''` als er geen PDF is), bijlagenaam, pdf-pad, mailtekst, ontvangen, afzender naam/e-mail, onderwerp; uitgelezen velden leverancier, factuurnummer, factuurdatum, vervaldatum, bedrag (incl. btw, creditnota negatief), valuta, IBAN, betalingskenmerk, omschrijving; `uitlees_status` (pending|ok|mislukt|handmatig|geen_factuur) + fout; `status` (open|betaald|genegeerd), betaald_op, betaald_via (bunq|handmatig), bunq_betaling_id, match_score, suggestie_betaling_id, suggestie_score, doorgestuurd_op, doorgestuurd_naar, notitie.
- `bunq_betalingen`: id, rekening-id/iban, datum, bedrag, valuta, tegenrekening-iban, tegenpartij-naam, omschrijving, gekoppelde_factuur_id.
- `instellingen` (key/value): `boekhouder_email` (meerdere met komma), `auto_doorsturen` (0/1), `auto_doorsturen_sinds` (tijdstip waarop de toggle aan ging), `testmodus` (standaard **1**), `doorstuur_tekst`, `outlook_categorie` (0/1), `match_drempel` (standaard 0.7, grenzen 0.4–1.0), `terugkijken_dagen` (standaard 365), `laatste_sync` + resultaat.
- `logboek`: tijd, factuur_id, niveau (info|warn|error), bericht. Elke actie en elke wijziging van instellingen (oud → nieuw) komt hierin.

### Graph (`https://graph.microsoft.com/v1.0`)
- Token: `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`, scope `https://graph.microsoft.com/.default`, cachen tot ± 2 min voor verloop. Retry met `Retry-After` bij 429/503/504.
- Map vinden: begin bij well-known `inbox` (werkt ook als die "Postvak IN" heet), per padonderdeel `GET /users/{mb}/mailFolders/{id}/childFolders?$filter=displayName eq '...'`.
- Mails: `GET .../mailFolders/{id}/messages` met `$select=id,subject,from,receivedDateTime,hasAttachments,categories`, filter `receivedDateTime ge` (terugkijkperiode), pagineren via `@odata.nextLink`. Bekende message_id's overslaan.
- Bijlagen: `GET /messages/{id}/attachments`, alleen `#microsoft.graph.fileAttachment`, niet inline, PDF (contentType of `.pdf`). Opslaan met veilige bestandsnaam. Geen PDF: mailtekst ophalen met header `Prefer: outlook.body-content-type="text"`.
- Doorsturen: `POST /messages/{id}/forward` met `comment` en `toRecipients` (originele mail mét PDF gaat mee).
- Categorie: huidige categorieën ophalen en `PATCH` met "Betaald" of "Doorgestuurd boekhouder" erbij.

### Uitlezen met Claude
Prompt (Nederlands): rol boekhoudassistent van De Koning Tegelwerken; antwoord met alleen JSON: `is_invoice, supplier, invoice_number, invoice_date (YYYY-MM-DD), due_date (uitrekenen bij betaaltermijn), amount (getal incl. btw, creditnota negatief), currency, iban, payment_reference, description (max 80 tekens)`; onbekend = null; niets verzinnen. Afzender en onderwerp als context meegeven. Robuust parsen: eerste `{…}` uit het antwoord, bedragen als "1.234,56" omzetten, IBAN zonder spaties in hoofdletters, datums normaliseren. `is_invoice: false` → status genegeerd (offerte, nieuwsbrief, orderbevestiging). Fout → `mislukt` met foutmelding, zichtbaar in het dashboard, opnieuw te proberen. Maximaal ± 25 per sync-ronde.

### bunq (`https://api.bunq.com/v1`, sandbox `https://public-api.sandbox.bunq.com/v1`)
- Eenmalig: RSA-2048 sleutelpaar → `POST /installation` (`client_public_key`) → installatietoken; `POST /device-server` (`description`, `secret` = API-key) registreert het huidige publieke IP van hfd-web01; daarna `POST /session-server` → sessietoken + user-id (UserCompany/UserPerson/UserApiKey). Requests met body ondertekenen: `X-Bunq-Client-Signature` = base64(RSA-SHA256 PKCS#1 v1.5 over de body). Vaste headers: `X-Bunq-Client-Request-Id` (uuid), `X-Bunq-Language/Region nl_NL`, `X-Bunq-Geolocation 0 0 0 0 000`, `Cache-Control no-cache`, `User-Agent`.
- State (sleutel, tokens, user-id) in `DATA_DIR/bunq_state.json`, 600. Bij een andere API-key opnieuw installeren; bij 401 sessie opnieuw opbouwen.
- Lezen: `GET /user/{id}/monetary-account` (alleen ACTIVE, IBAN uit alias, optioneel filter op `BUNQ_ACCOUNT_IBANS`) en `GET /user/{id}/monetary-account/{acc}/payment?count=200`, terugbladeren via `Pagination.older_url` tot de terugkijkperiode.

### Koppelen (betaling ↔ factuur)
Alleen uitgaande betalingen (bedrag < 0) en open facturen met bedrag. Score:
- bedrag exact gelijk (verschil ≤ 0,01) is **verplicht**: 0,40; anders 0
- betaling meer dan 7 dagen vóór factuurdatum (of ontvangstdatum): 0
- IBAN leverancier == tegenrekening: +0,40
- factuurnummer of kenmerk (alfanumeriek, ≥ 4 tekens) komt voor in de omschrijving: +0,30
- naam leverancier lijkt op tegenpartij (zonder BV/VOF/NV/holding, bevat elkaar of gelijkenis ≥ 0,75): +0,20
- maximaal 1,0

Greedy toewijzen: hoogste score eerst, elke betaling en factuur maximaal één keer. Score ≥ drempel → automatisch betaald (via bunq, met betaaldatum van de betaling). Lager → suggestie die Bob met één klik bevestigt. Suggesties worden elke ronde opnieuw berekend.

### Acties en doorsturen
- **Betaald zetten** (bunq of handmatig): status, datum, betaling koppelen, Outlook-categorie "Betaald" (als ingesteld), daarna eventueel automatisch doorsturen.
- **Terug naar open**: ontkoppelt de betaling weer.
- **Negeren**, **gegevens bewerken** (uitlees_status → handmatig), **opnieuw uitlezen**.
- **Doorsturen**:
  - geen boekhouderadres → niet versturen, waarschuwing in logboek en melding in het scherm;
  - handmatige knop verstuurt **altijd echt** (met bevestiging in de browser), ook opnieuw;
  - automatisch: alleen als `auto_doorsturen = 1`, alleen facturen met betaaldatum **op of na** `auto_doorsturen_sinds` (anders zou de hele historie van de eerste sync naar de boekhouder gaan), nooit twee keer, en een mail met meerdere PDF's maar één keer;
  - **testmodus** aan → automatisch doorsturen wordt alleen gelogd ("TESTMODUS: zou doorsturen naar …");
  - begeleidende tekst + leverancier, factuurnummer en betaaldatum; daarna categorie "Doorgestuurd boekhouder".
- **Sync-ronde** (elke `SYNC_INTERVAL_MIN` minuten en via knop; nooit twee tegelijk): mail → uitlezen → bunq → koppelen → achterstand doorsturen. Elke stap los afgevangen; resultaat per stap in `laatste_sync_resultaat`.

### Schermen (server-side HTML, Nederlands, huisstijl van deze repo: zand/antraciet/brons, Fraunces + Inter uit `assets/fonts/`, geen inline styles/scripts i.v.m. CSP; eigen CSS/JS-bestand mag)
1. **Overzicht**: tegels Openstaand (bedrag + aantal), Verlopen, Betaald deze maand, Nog naar boekhouder (met stand: handmatig / automatisch / testmodus), Te controleren (uitlezen mislukt of suggestie). Staafgrafiek factuurbedrag per maand (12 mnd), top-6 leveranciers (12 mnd). Lijst met filters Open, Verlopen, Betaald, Nog doorsturen, Controle, Genegeerd, Alle + zoekveld; open eerst op vervaldatum. Knop "Nu synchroniseren", laatste sync + resultaat.
2. **Factuur**: PDF in de pagina (eigen route, padcontrole binnen de pdf-map) of de mailtekst; knoppen Markeer als betaald / Terug naar open, Doorsturen naar boekhouder (uitgeschakeld zonder adres), Negeren; gekoppelde of voorgestelde bunq-betaling met zekerheid en knop "Klopt, koppel deze betaling"; bewerkformulier; "Opnieuw uitlezen"; geschiedenis uit het logboek.
3. **Instellingen**: e-mailadres(sen) boekhouder (validatie), begeleidende tekst, schakelaars **Automatisch doorsturen zodra betaald**, **Testmodus**, **Categorie zetten in Outlook**; matchdrempel en terugkijkperiode met uitleg; knop "Verbindingen testen" (Graph: map gevonden; bunq: rekeningen; Claude: sleutel aanwezig); logboek.

Bedragen als "€ 1.234,56", datums als "4 okt 2026". Mobiel bruikbaar.

### Uitrol (voorbereiden, niet uitvoeren)
- systemd-unit (eigen systeemgebruiker, `NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths` alleen de datamap), voorbeeld-env, en in `deploy/` een README met de stappen voor Bob: env invullen, unit installeren, `tailscale serve`.
- PowerShell-script `deploy/Setup-MailboxScope.ps1` voor Bob (draait hij op Windows): parameters AppId, ServicePrincipalObjectId (Enterprise App), Mailbox; vraagt bevestiging; idempotent; maakt `New-ServicePrincipal`, `New-ManagementScope -RecipientRestrictionFilter "PrimarySmtpAddress -eq '<mailbox>'"`, `New-ManagementRoleAssignment` voor "Application Mail.ReadWrite" en "Application Mail.Send" met `-CustomResourceScope`, en eindigt met `Test-ServicePrincipalAuthorization`.
- Stappenlijst voor de Entra app registration (client secret, géén Mail-API-permissions) en het aanmaken van de bunq API-key.

### Testen
`node --test` zonder echte koppelingen: Graph, bunq en Claude nagebootst. Minimaal: parsen van Claude-antwoorden (bedragnotaties, IBAN), bunq-ondertekening te verifiëren met de publieke sleutel, matching (exacte match automatisch; alleen bedrag → suggestie; betaling vóór factuurdatum → geen match; greedy), doorsturen (testmodus logt alleen, niets vóór `auto_doorsturen_sinds`, geen dubbele, handmatig altijd, geen adres → niets), alle pagina's 200 met en 401 zonder inlog, terug-naar-open ontkoppelt. Bestaande tests van de site moeten groen blijven.

## Werkwijze

**Fase A — inventaris en plan (nu, niets wijzigen):**
1. Lees `CLAUDE.md`, `docs/GEHEUGEN.md`, `docs/PLAN.md` en het dienstenpatroon in `/root/handsfree-digital-werk/service/` (contact.mjs, env-gebruik, systemd).
2. Controleer: Node-versie en of `node:sqlite` zonder vlag werkt; vrije poort op 127.0.0.1; of `tailscale` aanwezig is; of er al iets in `/etc/dekoning/` staat (alleen bestandsnamen, nooit inhoud van env-bestanden tonen); huidige branch en schone werkboom.
3. Lever een plan: mappenstructuur (bv. `service/facturen/` + `test/facturen.test.mjs` + `deploy/`), bestanden en verantwoordelijkheden, poort, systeemgebruiker en datamap, hoe je de huisstijl hergebruikt zonder de site te raken, testaanpak, risico's en open vragen.
4. Stop en wacht op akkoord van Bob.

**Fase B — bouwen (pas na "go"):**
Nieuwe branch `feature/factuurdashboard` vanaf `origin/main`. Leg deze opdracht ongewijzigd vast in `docs/opdrachten/factuurdashboard.md`. Bouw, test, commit in logische stappen (Nederlandse berichten), push de featurebranch, werk `docs/GEHEUGEN.md` bij met de stand en wat Bob nog zelf moet doen. Installeer niets systeembreed, start geen services, raak nginx niet aan.

---

## Antwoorden van Bob op de open vragen uit fase A (5 oktober 2026)

Fase A is goedgekeurd. De antwoorden hieronder horen bij het plan en gaan vóór elk voorstel
dat in fase A nog als open stond.

1. **Poort 8132**: akkoord. Bob registreert hem zelf in `/etc/handsfree/poorten.md` (staat als
   stap in `deploy/README.md`).
2. **`tailscale serve` op `/facturen`**, dus met `BASIS_PAD` (standaard leeg, zodat de root
   ook werkt).
3. **Eigen gebruiker `dekoning-facturen` + `/var/lib/dekoning-facturen`**, los van de
   website-diensten.
4. **`deploy/facturen-deploy.sh`** in de stijl van `preview-deploy.sh`: `git archive` van een
   branch naar `/opt/dekoning-facturen`, bevestiging vóór schrijven, voert geen `systemctl`
   uit en toont het herstartcommando voor Bob.
5. **bunq op `production`**; het risico dat de API-key volledige toegang geeft is geaccepteerd
   en staat als waarschuwing in de README.
6. **Geen terugval bij een weigering**; het verzoek blijft kaal en een weigering wordt netjes
   afgevangen als `mislukt`.
7. **Mailbox en mapnaam** vult Bob later in de env in; in voorbeelden staan placeholders.
8. **Boekhouderadres en begeleidende tekst leeg opgeleverd**, met het gedrag "geen adres →
   niets versturen, waarschuwing".
9. **Betaalde facturen van vóór `auto_doorsturen_sinds`** blijven zichtbaar onder "Nog naar
   boekhouder", worden nooit automatisch verstuurd en gaan alleen met de knop.
10. **Genormaliseerde Levenshtein** als gelijkenismaat (in plaats van `difflib.SequenceMatcher`
    uit het prototype) is prima, net als de vaste tie-break in het greedy toewijzen, de
    `Origin`/`Sec-Fetch-Site`-controle op POST's en `output_config.effort = "low"`.
