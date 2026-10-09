# Opdracht: factuurdashboard live + mailsorteerder + portaal cms.dekoningtegelwerken.nl
Opdrachtgever: Bob (Handsfree Digital). Datum: 9 oktober 2026. Repo: `/root/dekoning-tegelwerken` op hfd-web01. Volg `CLAUDE.md`: Nederlands, featurebranch, nooit `main` pushen of mergen. Deze opdracht vervangt de losse opdracht "mailsorteerder + portaal" van 8 oktober en de losse uitrolopdracht voor het factuurdashboard. Bestaat `docs/opdrachten/mailsorteerder-portaal.md` of de branch `feature/mailsorteerder-portaal` al, ga dan verder vanaf die stand in plaats van opnieuw te beginnen. Werk het opdrachtbestand bij met deze versie.
Toestemming: in afwijking van `CLAUDE.md` geef ik (Bob) je voor deze opdracht toestemming voor `useradd`, `systemctl`, `certbot` en een nieuwe nginx-vhost met `nginx -t` + reload. Vraag vóór elke stap die iets op het systeem wijzigt om mijn bevestiging en laat zien wat je gaat doen. Bestaande vhosts en diensten raak je niet aan, tenzij ik daar in fase A akkoord op geef.
Doel

1. Factuurdashboard in gebruik nemen (branch `feature/factuurdashboard`), eerst alleen lokaal op 127.0.0.1.
2. Mailsorteerder: nieuwe mail in de Inbox van de klant automatisch in de juiste map zetten. Facturen gaan naar Inbox › Facturen, waar het factuurdashboard ze oppakt.
3. Eén portaal op `https://cms.dekoningtegelwerken.nl`: factuurdashboard, mailsorteerder én de bestaande website-admin (offertes) achter één login met Microsoft (Entra SSO). Het dashboard gaat pas publiek als SSO werkt; tot die tijd alleen 127.0.0.1 met Basic Auth. Geen `tailscale serve` en geen `portal.`-subdomein.

Besluiten van Bob (staan vast)

* M365-mailtoegang: de bestaande app registration heeft Application permissions `Mail.ReadWrite` + `Mail.Send` in Entra, met admin consent. Er is maar één mailbox in de tenant, dus geen RBAC for Applications en geen `Setup-MailboxScope.ps1`. Deze app wordt hergebruikt voor het factuurdashboard én het sorteren. Er komen geen extra mailrechten bij. De gegevens staan al in `/etc/dekoning/facturen.env`.
* Mappen (onder Inbox, aanmaken via Graph als ze ontbreken): `Facturen` (bestaat), `Offerteaanvragen`, `Klanten & projecten`, `Leveranciers`, `Nieuwsbrieven & reclame`. Wat niet past, blijft in de Inbox.
* Direct verplaatsen, geen voorstelmodus. Twijfelgevallen blijven in de Inbox met Outlook-categorie `Controleren`.
* Eén portaal op `cms.`: facturen, mail en website-admin onder één login.
* Login: Microsoft (Entra SSO), OIDC authorization code flow met PKCE.
* Zelfde patroon als het factuurdashboard: dependency-vrije Node 22 (`node:http`, `node:sqlite`, `fetch`, `node:crypto`), geen npm, geen build-step.
* Model voor sorteren: `claude-haiku-4-5` (instelbaar via `SORT_MODEL`). Controleer in fase A of die naam bij de API werkt.

Specificatie
1. Mailsorteerder (uitbreiding van de facturen-dienst)
Ophalen

* Gebruik Graph delta query op `mailFolders/inbox/messages/delta`. Bewaar de deltaLink in SQLite.
* Bij de eerste start wordt alleen een deltaLink vanaf "nu" vastgelegd. Bestaande inboxmail wordt niet gesorteerd.
* Optioneel: een knop Bestaande inbox sorteren. Die toont eerst hoeveel mails per map zouden gaan en vraagt dan bevestiging.
* Webhook: Graph change notifications (`created`) naar `https://cms.dekoningtegelwerken.nl/graph/notify`.
   * Valideer `validationToken` en `clientState` (geheim uit env).
   * Verleng de subscription automatisch ruim voor het verloopt.
   * Bij een notificatie draai je alleen de delta-sync, de payload zelf vertrouw je niet.
   * Zolang `cms.` niet publiek is: geen subscription aanmaken, alleen pollen.
* Vangnet: polling elke 5 minuten (`SORT_INTERVAL_MIN`).

Overslaan (blijven in de Inbox, niet classificeren)

* Agenda-uitnodigingen (`eventMessage`).
* Gemarkeerde mails (flag).
* Concepten.
* Mails van de eigen mailbox of het eigen domein.

Classificeren, in deze volgorde

1. Regels uit de database (afzenderadres of domein → map). Een regel wint altijd; een adresregel wint van een domeinregel.
2. Offerteaanvragen van de website: herkennen aan de afzender of header die de offerte-wizard/contact-dienst gebruikt (uitzoeken in fase A). Direct naar `Offerteaanvragen`, zonder AI.
3. Claude API:
   * Meegeven: afzender, onderwerp, eerste 1500 tekens platte tekst, bijlagenamen. Geen bijlagen meesturen.
   * Antwoord als JSON: `{map, zekerheid 0..1, reden}`.
   * Een PDF-bijlage met factuurachtige naam of tekst telt zwaar mee voor `Facturen`.
   * Bij een orderbevestiging, offerte of creditnota-aankondiging zonder factuur: `Leveranciers`.

Verplaatsen

* Zekerheid ≥ `sorteer_drempel` (instelling, standaard 0.75) → `move` naar de map.
* Daaronder blijft de mail staan en krijgt hij categorie `Controleren`.
* Na een move verandert het message-id. Sla het nieuwe id op.
* Nooit verwijderen, nooit markeren als gelezen.

Logboek en terugzetten

* Tabel met per mail: tijd, afzender, onderwerp, van-map, naar-map, bron (regel/website/AI), zekerheid, reden.
* Knop Terugzetten verplaatst de mail terug naar de Inbox.
* Knop Andere map verplaatst de mail en vraagt "Altijd zo voor deze afzender / dit domein?". Bij ja wordt het een regel.

Pagina's in het portaal

* Mail: logboek met filters per map en bron, plus de knoppen hierboven.
* Regels: lijst, toevoegen, verwijderen.
* Instellingen:
   * sorteren aan/uit (standaard aan);
   * drempel;
   * per map aan/uit;
   * webhook-status en verlooptijd van de subscription;
   * Verbindingen testen checkt ook of de mappen bestaan.

Robuust

* Maximaal één sorteerrun tegelijk.
* Graph 429/503 respecteren (Retry-After).
* Een mislukte classificatie laat de mail ongemoeid staan en logt de fout.

2. Portaal en Entra SSO
Entra

* Een aparte app registration `DKT Portaal`, gescheiden van de mail-app:
   * delegated;
   * redirect `https://cms.dekoningtegelwerken.nl/auth/callback`;
   * alleen `openid profile email`;
   * client secret.
* Assignment required op de enterprise app, zodat alleen toegewezen gebruikers kunnen inloggen.
* Daarbovenop `PORTAL_ALLOWED_EMAILS` (komma-gescheiden) in env.

OIDC

* Authorization code + PKCE en `state`/`nonce`.
* Valideer de id_token-handtekening zelf via de JWKS van de tenant (`node:crypto` + JWK import, sleutels cachen). Controleer ook `iss`, `aud`, `exp`, `tid` en `nonce`.
* Na het inloggen een server-side sessie in SQLite.
* Cookie: `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`, 8 uur geldig en schuivend.
* Uitloggen doet een lokale logout plus de Entra logout-redirect.

Overige beveiliging

* CSRF-token op alle POST-formulieren (naast de bestaande Origin/Sec-Fetch-Site-controle).
* Basic Auth vervalt zodra SSO geconfigureerd is. Zonder SSO-config blijft de dienst alleen op 127.0.0.1 met Basic Auth.
* `BASIS_PAD`: het factuurdashboard komt onder `cms.…/facturen/`, de mail onder `cms.…/mail/`; de startpagina op `/`.

Eén login voor de website-admin

* Het portaal biedt `GET /auth/check`: 200 met header `X-Portal-User` bij een geldige sessie, anders 401.
* nginx gebruikt dit via `auth_request` voor de admin-locatie.
* Zoek in fase A uit hoe de website-admin nu inlogt (wachtwoord + TOTP, subdomein, poort). Stel voor hoe hij achter `cms.…/offertes/` (of vergelijkbaar) komt en de `X-Portal-User` alleen van 127.0.0.1 vertrouwt.
* Het bestaande inlogmechanisme blijft werken voor andere hosts, of wordt netjes uitgeschakeld. Doe een voorstel en vraag Bob om akkoord.

Portaal-startpagina

* Tegels: Facturen (open/verlopen), Mail (gesorteerd vandaag, te controleren), Offertes (nieuw).
* Bovenin de naam van de ingelogde gebruiker en Uitloggen.
* Huisstijl van de site hergebruiken.
* `X-Robots-Tag: noindex`.

3. Deploy-bestanden

* `deploy/nginx/cms.dekoningtegelwerken.nl.conf`:
   * HTTP → HTTPS;
   * HSTS;
   * `limit_req` op `/auth/` en `/graph/notify`;
   * `client_max_body_size` passend;
   * `proxy_set_header Host`, `X-Forwarded-Proto`, `X-Forwarded-For`;
   * `/graph/notify` zonder `auth_request` maar met eigen clientState-check;
   * de rest via het portaal;
   * de admin-locatie via `auth_request`.
* fail2ban-filter op mislukte `/auth/callback` en 401's.
* Env-voorbeeld bijwerken met de nieuwe variabelen:
   * `PORTAL_BASE_URL`, `ENTRA_PORTAL_CLIENT_ID`, `ENTRA_PORTAL_CLIENT_SECRET`, `PORTAL_ALLOWED_EMAILS`, `SESSION_SECRET`;
   * `SORT_MODEL`, `SORT_INTERVAL_MIN`, `GRAPH_WEBHOOK_SECRET`.
   * Bij de M365-regels: twee routes, Entra Mail-permissions (één mailbox, nu in gebruik) of RBAC via `Setup-MailboxScope.ps1` (meerdere mailboxen), nooit allebei.
* `deploy/CMS-INSTALLATIE.md` met de stappen van fase C als kopieerbare bash-blokken met controles en bevestigingsvragen.

Testen
`node --test` zonder echte koppelingen (Graph, Claude en Entra nagebootst). Minimaal:

* Regels: een regel wint van AI; domeinregel versus adresregel.
* Website-offerte: gaat zonder AI naar `Offerteaanvragen`.
* Overslaan: event, flag, concept, eigen afzender.
* Drempel: onder de drempel geen move maar categorie `Controleren`.
* Moves: bij een move wordt het nieuwe id opgeslagen; terugzetten werkt; correctie met "altijd" maakt een regel.
* Delta: de eerste run sorteert niets historisch.
* Webhook: validatie van `validationToken` en `clientState`; een foute `clientState` geeft 401.
* OIDC:
   * geldige token → sessie;
   * foute `aud`/`iss`/`nonce`/handtekening of verlopen token → geweigerd;
   * e-mail niet in de allowlist → 403.
* Portaal: `/auth/check` geeft 200/401; CSRF ontbreekt → 403; alle pagina's 200 met sessie, zonder sessie redirect naar login.
* Bestaande tests (site en facturen) moeten groen blijven.

Werkwijze
Fase 0 — factuurdashboard lokaal in gebruik nemen (nu, met bevestiging per stap):

1. Controleer `/etc/dekoning/facturen.env`: rechten 600 root:root. Meld per variabele alleen gevuld/leeg, toon nooit een waarde. Zijn `DASHBOARD_USER`/`DASHBOARD_PASSWORD` leeg: gebruiker `bob`, wachtwoord via `openssl rand -base64 24`, toon het één keer aan het eind. `ANTHROPIC_API_KEY` en `BUNQ_API_KEY` mogen leeg blijven.
2. Systeemgebruiker `dekoning-facturen` aanmaken als die ontbreekt (commando uit de README).
3. Poort 8132 in `/etc/handsfree/poorten.md` ("In gebruik op web01", "cms.dekoningtegelwerken.nl").
4. `deploy/facturen-deploy.sh --droog feature/factuurdashboard`, uitvoer tonen, na akkoord echt.
5. `deploy/dekoning-facturen.service` installeren, `daemon-reload`, `enable --now`; status en laatste 30 regels journal tonen.
6. curl op 127.0.0.1:8132: zonder inlog 401, met inlog 200.
7. Verbindingstest (zelfde als de knop): verwacht Microsoft 365 ok (map Inbox/Facturen gevonden), Claude en bunq "niet geconfigureerd". Bij 401/403 van Graph: 5 minuten wachten (admin consent) en nog één keer; daarna de foutmelding zonder secrets rapporteren.
8. Na de eerste sync: hoeveel mails zijn ingelezen, en bevestigen dat er niets is doorgestuurd.

Fase A — inventaris en plan (direct na fase 0, niets wijzigen):

1. Lees `CLAUDE.md`, `docs/GEHEUGEN.md`, `docs/PLAN.md`, `docs/opdrachten/factuurdashboard.md` en de facturen-dienst.
2. Stel vast:
   * poort, env-pad en of de dienst nu draait (uitkomst fase 0);
   * hoe de website-admin inlogt en op welke host/poort hij draait;
   * welke afzender of header de offerte-mails hebben;
   * welke nginx-vhosts er zijn (alleen bestandsnamen); is certbot aanwezig;
   * het publieke IP en of `cms.dekoningtegelwerken.nl` al in DNS staat;
   * of `claude-haiku-4-5` werkt als modelnaam;
   * branchstatus.
   * Toon nooit de inhoud van env-bestanden.
3. Lever een plan: bestanden en verantwoordelijkheden, datamodel, hoe de admin achter het portaal komt, risico's en open vragen voor Bob.
4. Stop en wacht op akkoord.

Fase B — bouwen (pas na "go"):

* Branch `feature/mailsorteerder-portaal` vanaf `feature/factuurdashboard` (of `origin/main` als die al gemerged is).
* Leg deze opdracht ongewijzigd vast in `docs/opdrachten/mailsorteerder-portaal.md`.
* Bouw, test en commit in logische stappen (Nederlandse berichten) en push de featurebranch.
* Werk `docs/GEHEUGEN.md` bij.
* Raak in deze fase het systeem niet aan.
* Stop en meld wat er gebouwd is en wat ik in Entra moet doen.

Fase C — live op cms. (pas na "go", met bevestiging per stap):

1. DNS: controleer met `dig` of `cms.dekoningtegelwerken.nl` naar het publieke IP wijst. Zo niet: stop en meld het.
2. certbot voor `cms.dekoningtegelwerken.nl`, zoals bij de site (webroot `/var/www/html`).
3. Entra: ik maak `DKT Portaal` aan volgens jouw stappen en vul de env aan. Wacht tot ik "klaar" zeg; controleer daarna alleen gevuld/leeg.
4. `deploy/facturen-deploy.sh` met de nieuwe branch, dienst herstarten, status + journal.
5. nginx-vhost naar `/etc/nginx/sites-enabled/`, `nginx -t`, pas bij succes reload. fail2ban-filter alleen plaatsen na mijn akkoord.
6. Van buitenaf testen: http → https, `/` stuurt naar de Microsoft-login, `/auth/check` zonder sessie 401, `/graph/notify` met foute clientState 401.
7. Ik log in; jij controleert daarna de webhook-subscription en de eerste gesorteerde mail.
8. `docs/GEHEUGEN.md` bijwerken, committen, pushen.

Sluit af met: URL, uitkomst per fase, testresultaten (nieuw én bestaand) en wat er nog openstaat (Claude-sleutel, bunq-sleutel, boekhouderadres, back-up, eventueel de admin-overstap).

## Antwoorden en correcties van Bob bij de "go" voor fase B (9 oktober 2026)

Letterlijk overgenomen; waar dit afwijkt van de opdracht hierboven, geldt dit.

1. Graph-rechten: opgelost via Exchange RBAC for Applications. De app (dcab51df-1a41-4435-ba69-dfc63b9f87f3) heeft Application Mail.ReadWrite + Mail.Send ALLEEN op info@dekoningtegelwerken.nl (scope Scope-FactuurdashboardDKT, getest: InScope True voor DKT, False voor andere mailboxen). Er staan GEEN Mail-rechten in Entra. De tenant is gedeeld met andere mailboxen/domeinen van Bob en klanten.
   Pas de risicotekst aan: niet "acceptabel zolang er één mailbox is", maar "toegang via RBAC-scope op één mailbox; nooit Entra Mail-rechten toevoegen". Neem dit op in README, CMS-INSTALLATIE.md en GEHEUGEN.md.
   Let op: het access token bevat met RBAC geen roles-claim. Gebruik dat niet als check in "Verbindingen testen"; test echt op de mailbox.

2. ANTHROPIC_API_KEY staat in /etc/dekoning/facturen.env. Sorteren met Claude mag aan.

3. Offerteaanvragen: geen vast afzenderadres. Bouw de regels in de database en voeg een instelling "website-afzenders" toe (lijst van adressen/domeinen, standaard leeg) die als bron "website" telt, zonder AI. Bob vult die later in.

4. Admin: akkoord. Nu een tegel "Offertes" met een link naar de tenant met zijn eigen login. Offerteknop blijft ongewijzigd; de echte SSO-koppeling volgt later in de Offerteknop-repo. Het platformbrede SSO-geheim van Offerteknop niet naar cms.

5. DNS: cms.dekoningtegelwerken.nl → 178.104.144.203 zet ik zelf vóór fase C. Neem de check-commando's op in CMS-INSTALLATIE.md.

Extra eis: zet de mailkoppeling achter een vaste interface (nieuweBerichten, verplaats, categorie, doorsturen, mapAanmaken) met MAIL_PROVIDER=m365. Zo kan later een Gmail-adapter worden toegevoegd zonder verbouwing. Bouw nu alleen m365.

Werk alles in de voorgrond af, commit in logische stappen, push feature/mailsorteerder-portaal, werk docs/GEHEUGEN.md bij en sluit af met wat ik nog zelf moet doen.
