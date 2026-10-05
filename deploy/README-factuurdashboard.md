# Factuurdashboard — stappen voor Bob

Het factuurdashboard is een losse Node-dienst (`service/facturen/`) die de map
**Inbox › Facturen** van de Microsoft 365-mailbox uitleest, de facturen met de
Claude API laat uitlezen, ze koppelt aan uitgaande bunq-betalingen en betaalde
facturen naar de boekhouder doorstuurt.

Het staat **niet** op de website. Het luistert op `127.0.0.1:8132`, is alleen
via het tailnet bereikbaar (`tailscale serve`) en heeft daarbovenop Basic Auth.
Er komt geen nginx-vhost bij en er gaat niets open naar buiten.

| Bestand | Wat |
|---|---|
| `dekoning-facturen.service` | systemd-unit: eigen gebruiker, `ProtectSystem=strict`, schrijven alleen in `/var/lib/dekoning-facturen`. |
| `facturen.env.voorbeeld` | Alle instellingen met placeholders. Kopiëren naar `/etc/dekoning/facturen.env` (600). |
| `facturen-deploy.sh` | Zet een branch (gecommitte staat, via `git archive`) in `/opt/dekoning-facturen`. Herstart niets. |
| `Setup-MailboxScope.ps1` | Draai jij op Windows: geeft de app toegang tot precies één mailbox via Exchange RBAC for Applications. |

> **Over de bunq-sleutel.** Een bunq API-key geeft **volledige toegang** tot de
> rekening. Dat dit dashboard alleen leest, zit in de code en niet in de
> sleutel: bunq kent geen alleen-lezen-variant. Behandel
> `/etc/dekoning/facturen.env` dus als een bankpas, en zet de sleutel nergens
> anders neer.

## 1. Entra: app-registratie (in de browser, portal.azure.com)

De app krijgt **geen enkele Mail-permission**. Zou je `Mail.Read` of `Mail.Send`
toekennen, dan kan de app bij élke mailbox in de tenant; de begrenzing tot één
mailbox gebeurt in stap 2, in Exchange zelf.

1. **Entra ID › App registrations › New registration**. Naam bijvoorbeeld
   `De Koning Facturen`, accounts: *Single tenant*, geen redirect URI.
2. Noteer op **Overview**: *Application (client) ID* en *Directory (tenant) ID*.
3. **Certificates & secrets › New client secret**. Geef hem een looptijd en
   noteer de **Value** meteen; daarna is hij niet meer te zien. Zet een
   herinnering voor de vervaldatum, anders valt het dashboard stil.
4. **API permissions**: hier hoort **niets** te staan behalve het standaard
   `User.Read`. Voeg niets toe.
5. Ga naar **Enterprise applications**, zoek dezelfde app en noteer daar het
   **Object ID**. Dat is een ándere waarde dan het Object ID van de
   app-registratie; het script in stap 2 heeft juist deze nodig. Dit is de fout
   die hier het vaakst gemaakt wordt.

## 2. Exchange: toegang tot één mailbox (op Windows)

```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser
Connect-ExchangeOnline -UserPrincipalName <beheerder>@<tenant>

.\Setup-MailboxScope.ps1 `
  -AppId <application-client-id> `
  -ServicePrincipalObjectId <object-id-van-de-enterprise-application> `
  -Mailbox <mailbox>@<domein>
```

Het script laat eerst zien wat het gaat doen en vraagt om bevestiging. Het is
idempotent: opnieuw draaien maakt niets dubbel aan. Het sluit af met
`Test-ServicePrincipalAuthorization`. Staat daar nog niet alles als `InScope`,
wacht dan een kwartier en draai het nog eens.

De map **Facturen** moet in de mailbox onder Inbox bestaan. Een geneste map mag
ook; vul dan het hele pad in `M365_FOLDER` in, bijvoorbeeld `Facturen/2026`.

## 3. bunq: API-key maken (in de bunq-app)

1. **Profiel › Beveiliging & instellingen › Ontwikkelaars › API-sleutels ›
   Nieuwe sleutel**.
2. Kies een duidelijke naam, bijvoorbeeld `hfd-web01 factuurdashboard`.
3. Kopieer de sleutel naar `BUNQ_API_KEY` in `/etc/dekoning/facturen.env`.

Bij de eerste ronde registreert het dashboard zichzelf bij bunq als apparaat.
Daarbij legt bunq het **huidige publieke IP-adres van hfd-web01** vast.
Verandert dat adres, dan weigert bunq de verzoeken; zie stap 6.

## 4. Op hfd-web01 (als root)

**4.1 Gebruiker en poort**

```bash
adduser --system --group --no-create-home --home /nonexistent dekoning-facturen
```

Zet poort **8132** erbij in `/etc/handsfree/poorten.md`, in de tabel "In gebruik
op web01", zodat hij niet nog eens wordt uitgedeeld.

**4.2 Instellingen**

```bash
mkdir -p /etc/dekoning
install -m 600 -o root -g root \
  /root/dekoning-tegelwerken/deploy/facturen.env.voorbeeld /etc/dekoning/facturen.env
${EDITOR:-nano} /etc/dekoning/facturen.env
```

Minimaal invullen: `DASHBOARD_USER` en `DASHBOARD_PASSWORD` — zonder die twee
laat het dashboard niemand binnen. Een wachtwoord maken:
`openssl rand -base64 24`. Wat verder leeg blijft, slaat zijn stap over; welke
koppelingen ontbreken, staat op de instellingenpagina.

**4.3 Code neerzetten**

```bash
/root/dekoning-tegelwerken/deploy/facturen-deploy.sh --droog feature/factuurdashboard
/root/dekoning-tegelwerken/deploy/facturen-deploy.sh feature/factuurdashboard
```

**4.4 Dienst installeren en starten**

```bash
cp /root/dekoning-tegelwerken/deploy/dekoning-facturen.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now dekoning-facturen
systemctl status dekoning-facturen --no-pager
```

Controleren dat hij staat en dat er niemand zonder wachtwoord binnenkomt:

```bash
curl -sI http://127.0.0.1:8132/facturen/ | head -1                      # 401
curl -sI -u 'GEBRUIKER:WACHTWOORD' http://127.0.0.1:8132/facturen/ | head -1   # 200
```

**4.5 Bereikbaar maken via het tailnet**

```bash
tailscale serve --bg --set-path /facturen http://127.0.0.1:8132
tailscale serve status
```

Daarna staat het dashboard op `https://hfd-web01.tail20628d.ts.net/facturen/`,
alleen voor apparaten in het tailnet. Het pad `/facturen` hoort bij
`BASIS_PAD=/facturen` in de env: die twee moeten gelijk zijn. Zet je het op de
root (`tailscale serve --bg http://127.0.0.1:8132`), maak `BASIS_PAD` dan leeg.

**4.6 De eerste rondes**

Testmodus staat standaard **aan**: automatisch doorsturen wordt dan alleen in
het logboek gezet, er gaat niets echt weg. Laat dat zo tot je een paar rondes
hebt nagekeken. De knop "Verbindingen testen" op de instellingenpagina wijzigt
niets.

De volgorde die we aanraden:

1. draai eerst **zonder** boekhouderadres en kijk of de facturen goed worden
   uitgelezen en aan de juiste betalingen gekoppeld;
2. vul daarna het adres in en stuur met de knop één factuur handmatig door;
3. gaat dat goed, zet dan **Automatisch doorsturen** aan en **Testmodus** uit.

Die schakelaar legt zijn eigen startmoment vast: alleen facturen die dáárna
betaald zijn gaan automatisch mee. Wat daarvóór al betaald was, blijft onder
"Nog naar boekhouder" staan en gaat alleen met de knop. Zo gaat de hele
historie niet in één keer naar de boekhouder.

## 5. Back-up

In `/var/lib/dekoning-facturen` staan de database, de PDF's van de facturen en
`bunq_state.json`. Dat valt nu onder geen enkele back-up. Een SQLite-bestand mag
je niet zomaar kopiëren terwijl er geschreven wordt; `VACUUM INTO` maakt wel een
consistente kopie:

```bash
install -d -m 700 /var/backups/dekoning-facturen
sqlite3 /var/lib/dekoning-facturen/facturen.db \
  "VACUUM INTO '/var/backups/dekoning-facturen/facturen-$(date +%F).db'"
tar czf /var/backups/dekoning-facturen/pdfs-$(date +%F).tar.gz \
  -C /var/lib/dekoning-facturen pdfs
```

`bunq_state.json` hoeft niet mee: raakt die kwijt, dan bouwt het dashboard de
installatie en de sessie zelf opnieuw op. De PDF's wél — die staan verder alleen
nog in de mailbox.

## 6. Als er iets misgaat

**503 met "nog niet ingesteld".**
`DASHBOARD_USER` of `DASHBOARD_PASSWORD` ontbreekt in
`/etc/dekoning/facturen.env`.

**Een stap wordt overgeslagen.**
Dat is de bedoeling als een koppeling niet is ingevuld. Welke het is, zie je op
de instellingenpagina onder "Verbindingen testen" en in de regel onder "Nu
synchroniseren".

**"map Facturen niet gevonden".**
De naam in `M365_FOLDER` komt niet overeen met de map in de mailbox. Het
dashboard begint bij de well-known map `inbox` (dus ook als die "Postvak IN"
heet) en loopt van daaruit het pad af. Hoofdletters en spaties tellen mee.

**bunq weigert ineens.**
Bij het registreren legt bunq het publieke IP van hfd-web01 vast (bij het
schrijven van deze regels `178.104.144.203`). Verandert dat, dan komt er een
melding over het IP-adres in het logboek. Opnieuw beginnen:

```bash
systemctl stop dekoning-facturen
mv /var/lib/dekoning-facturen/bunq_state.json /var/lib/dekoning-facturen/bunq_state.json.oud
systemctl start dekoning-facturen
```

De volgende ronde maakt een nieuw sleutelpaar en registreert het nieuwe adres.
Hetzelfde gebeurt vanzelf zodra je de API-key vervangt.

**Het uitlezen mislukt bij een factuur.**
De melding staat bij de factuur zelf en in het logboek. Met "Opnieuw uitlezen"
gaat hij de volgende ronde weer mee; met "Gegevens corrigeren" vul je ze met de
hand in. De factuur krijgt dan de stand *handmatig* en wordt niet meer
overschreven door het uitlezen.

**Niets gaat door naar de boekhouder.**
Loop deze vier langs: staat er een e-mailadres bij de instellingen, staat
testmodus uit, staat automatisch doorsturen aan, en is de factuur betaald ná
het moment waarop die schakelaar aanging? Elke overgeslagen factuur vertelt op
zijn eigen pagina waarom hij niet automatisch meegaat.

## 7. Bijwerken na nieuwe commits

```bash
/root/dekoning-tegelwerken/deploy/facturen-deploy.sh <branch>
systemctl restart dekoning-facturen
```

De database en de PDF's blijven staan; het deploy-script raakt
`/var/lib/dekoning-facturen` niet aan.
