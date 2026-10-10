# Opdracht: offertesysteem De Koning Tegelwerken (Offerteknop + portaal)

Opdrachtgever: Bob (Handsfree Digital). Datum: 10 oktober 2026.
Repo's op hfd-web01:
- `offerteknop-app` (multi-tenant Offerteknop, hoofdwerk);
- `dekoning-tegelwerken` (portaal cms.dekoningtegelwerken.nl, koppeling).

Volg in beide repo's `CLAUDE.md`: Nederlands, featurebranch, nooit `main` pushen of mergen, `systemctl`/nginx zijn voor Bob.

## Doel

De Koning Tegelwerken maakt offertes in **Offerteknop (tenant DKT)**, met zijn eigen prijslijst. Het portaal op cms. is de ingang:
- aanvragen worden met één klik een concept-offerte;
- de status van offertes is zichtbaar in het portaal;
- later wordt een geaccepteerde offerte een factuur.

## Besluiten van Bob (staan vast)

- **Offertes leven in Offerteknop**, tenant DKT. Er komt geen offertecode in het portaal; het portaal koppelt via een API.
- **Bron:** handmatig opstellen, en met één klik een concept maken uit een website-aanvraag of een mail in Inbox › Offerteaanvragen. Er worden geen automatische concepten gemaakt.
- **Akkoord:** de klant krijgt een mail met PDF plus een unieke akkoordlink. De status wordt automatisch bijgewerkt.
- **Btw:** per offerte kiezen tussen particulier (bedragen incl. 21% btw) en zakelijk (excl. btw, btw apart). Intern wordt altijd excl. btw gerekend, met afronding per regel op centen.
- Het platformbrede SSO-geheim van Offerteknop gaat niet naar cms. SSO naar Offerteknop blijft een aparte, latere stap.

## Specificatie

### 1. Offerteknop: wat er voor tenant DKT moet zijn

Inventariseer in fase A wat Offerteknop al kan. Bouw alleen wat ontbreekt, generiek per tenant. Niets mag DKT-specifiek in de code staan, alleen in tenantdata.

**Prijsboek per tenant.** Elke regel heeft:
- een categorie (wand, vloer, extra, materiaal);
- een omschrijving;
- een tegelformaat van–tot in cm. De maatstaf is de langste zijde, tenzij Bob anders beslist;
- een patroon (recht, visgraat);
- een eenheid (m², stuk, vast, staffel);
- een prijs excl. btw;
- een minimum of staffel (bijvoorbeeld "tot X m² vast bedrag, daarboven per m²");
- een vlag "op aanvraag";
- actief/inactief.

Prijzen zijn alleen via de beheer-UI aan te passen.

**Offerte-editor**
- Klantgegevens (particulier/zakelijk, adres, projectadres).
- Regels: kies categorie, formaat en patroon, vul hoeveelheid in; de prijs komt uit het prijsboek. Elke regel is overschrijfbaar, met een markering "aangepast".
- Vrije regels, voor werk dat "op aanvraag" is.
- Korting (bedrag of %), geldigheid in dagen (standaard instelbaar), en een notitie voor de klant.
- Interne notitie (niet op de PDF).
- Voorbeeld van de PDF.

**Nummering:** per tenant, oplopend per jaar, bijvoorbeeld `OFF-2026-0001`, zonder gaten bij concepten. Een nummer wordt pas toegekend bij het versturen.

**PDF** in de huisstijl van de tenant:
- logo, NAW, KvK, btw-nummer, IBAN;
- regels en totalen;
- btw volgens het klanttype;
- voorwaarden en geldigheid.

**Akkoordlink**
- Een publieke pagina met een willekeurig token van minstens 128 bits.
- De link is ongeldig na verloop of na intrekking.
- De klant geeft akkoord (naam en vinkje), of wijst af met een reden.
- Er wordt gelogd: tijd, IP, user-agent, en een hash van de PDF-versie waarvoor akkoord is gegeven.
- Na akkoord kan de offerte niet meer gewijzigd worden; een wijziging betekent een nieuwe versie.

**Statussen:** concept → verstuurd → bekeken → geaccepteerd / afgewezen / verlopen / ingetrokken.
- Verstuurde offertes kun je alleen nog als nieuwe versie wijzigen.
- Een herinnering naar de klant is optioneel en instelbaar per tenant. Standaard staat die uit.

**Versturen:** de mail moet vanaf **info@dekoningtegelwerken.nl** gaan.
- Stel in fase A voor hoe dat gaat:
  - via een tenantinstelling "verzenden via externe mailer-API" die het portaal aanroept (zie 2);
  - of via Offerteknops eigen mailer met Reply-To.
- Bob geeft de voorkeur aan versturen via het portaal: dan staat de mail in zijn Verzonden items en blijft de Graph-scope op één mailbox.

### 2. Koppeling portaal ⇄ Offerteknop

Beide draaien op hfd-web01. Verkeer loopt **alleen via 127.0.0.1**.

**Authenticatie:** HMAC-SHA256 over method + pad + timestamp + body.
- Elke kant heeft een eigen sleutel in env (600).
- Verzoeken ouder dan 5 minuten worden geweigerd.
- Er is een replay-cache.

Offerteknop krijgt een tenant-API (alleen voor tenants met een gekoppelde sleutel):
- `POST /api/tenant/offertes/concept`: klant, project, omschrijving en bijlagen-referenties. Geeft een concept-id en een bewerk-URL terug.
- `GET /api/tenant/offertes?sinds=…`: lijst met nummer, klant, bedrag, status en datums.
- **Webhook naar het portaal** bij statuswijziging (verstuurd, bekeken, geaccepteerd, afgewezen, verlopen), ook met HMAC.

Het portaal krijgt:
- `POST /intern/mail/verstuur` (alleen 127.0.0.1 + HMAC): Offerteknop levert ontvanger, onderwerp, HTML-body en PDF aan, en het portaal verstuurt via Graph `sendMail` vanaf de mailbox.
  - Er geldt een rate limit.
  - De ontvanger moet het adres uit het concept zijn; vrije relay is niet toegestaan.
- **"Maak offerte" bij een mail** in Inbox › Offerteaanvragen (Mail-pagina): de afzender, naam, telefoon en tekst (Claude mag dit uit de mail halen) en eventuele foto's gaan naar `concept`. Daarna volgt een redirect naar de bewerk-URL in Offerteknop.
- **Pagina "Offertes"** in plaats van de externe link-tegel:
  - een lijst uit de API, met filters op status en zoeken;
  - een knop "Openen in Offerteknop";
  - de startpagina toont tegels voor openstaand, wacht op akkoord, geaccepteerd deze maand en bedrag.
- Een **website-aanvraag** van de offerte-wizard wordt op dezelfde manier een concept, zodra de wizard een backend heeft. Bereid het datamodel daarop voor.

**Later** (nu alleen het datamodel voorbereiden): een geaccepteerde offerte wordt een uitgaande factuur.

### 3. Startdata prijsboek DKT (tenantdata, geen code)

Bedragen zoals aangeleverd door Bob. Of ze incl. of excl. btw zijn, is nog open (zie vragen). Laad ze als seed die idempotent is en in de UI aanpasbaar.

**Wanden**

| Formaat | Prijs |
|---|---|
| 15×15 t/m 80×80 | €67,50/m² |
| 90×90 | €70/m² |
| 100×100 | €72,50/m² |
| 120×120 | €75/m² |
| Visgraat | €85/m² |

Groter dan 120×120 of speciaal werk: op aanvraag.

**Vloeren**

| Formaat | Prijs |
|---|---|
| 30×30 t/m 80×80 | €67,50/m² |
| 90×90 | €70/m² |
| 100×100 | €72,50/m² |
| 120×120 | €75/m² |

**Extra's**

| Post | Prijs |
|---|---|
| Nisje betegelen (douche, raam, enz.) | €75/stuk |
| Materiaal badkamer tot 25 m² | €400–€500 (bandbreedte: standaard €400, aanpasbaar) |
| Vloer smeren tot 3 cm | "4 m² €380 incl. materiaal" (staffel, interpretatie open) |
| Profielen, dorpels, kitwerk | op aanvraag |

Open punten die Claude Code **niet** zelf invult maar als vraag aan Bob teruggeeft:
- Zijn de prijzen incl. of excl. btw?
- Is het alleen arbeid (klant levert de tegels)?
- Welke regel bepaalt materiaal €400 of €500, en wat geldt boven 25 m²?
- Interpretatie smeervloer: €380 per 4 m², of een vast bedrag tot 4 m²? Wat geldt erboven?
- Welke maat bepaalt de prijs bij rechthoekige tegels?
- Wat geldt voor vloertegels kleiner dan 30×30?
- Visgraat ook op vloeren?
- Wat is het bedrag €718,90 op de prijslijst?
- Komen er voorrijkosten, sloop/afvoer, voorbereiding of een minimumbedrag bij?

## Testen

`node --test` (of de bestaande testopzet van Offerteknop), met mail, Graph en de andere kant nagebootst. Minimaal:
- **Prijsberekening:**
  - formaatbereik op de langste zijde;
  - visgraat;
  - staffel/minimum;
  - "op aanvraag" geeft geen prijs maar een vrije regel;
  - overschrijven wordt gemarkeerd;
  - btw particulier versus zakelijk;
  - afronding.
- **Nummering:** zonder gaten, per jaar, pas bij versturen.
- **Akkoordlink:**
  - geldig;
  - verlopen;
  - ingetrokken;
  - een fout token geeft 404;
  - na akkoord niet meer te wijzigen;
  - de hash van de PDF-versie wordt opgeslagen.
- **HMAC:**
  - geldig;
  - fout;
  - een te oud verzoek wordt geweigerd;
  - een replay wordt geweigerd;
  - verkeer van buiten 127.0.0.1 wordt geweigerd.
- **Mail-relay in het portaal:** alleen het ontvangeradres van de offerte is toegestaan; de rate limit werkt.
- **Concept uit mail:** de juiste velden komen bij Offerteknop aan.
- **Tenantisolatie:** tenant A ziet nooit offertes, prijsboek of API-data van tenant B.
- Bestaande tests in beide repo's blijven groen.

## Werkwijze

**Fase A: inventaris en plan.** Wijzig niets.
1. Lees in **offerteknop-app**:
   - `CLAUDE.md`, de docs en het tenantmodel;
   - wat er al bestaat aan offertes, prijzen, PDF, mail, publieke links en API;
   - of tenant DKT al bestaat;
   - de huidige branchstatus.
2. Lees in **dekoning-tegelwerken**:
   - `docs/GEHEUGEN.md`;
   - de stand van `feature/mailsorteerder-portaal` (gemerged? live?);
   - de mail- en Graph-modules.
3. Lever:
   - een gat-analyse (wat er al is en wat er moet komen, per repo);
   - het datamodel;
   - het API-contract;
   - een voorstel voor het versturen;
   - een volgorde in kleine, los op te leveren stappen;
   - risico's;
   - de open vragen hierboven, aangevuld met wat je vindt.
4. Stop en wacht op akkoord van Bob.

**Fase B: bouwen** (pas na "go").
- Featurebranches:
  - `feature/offertes-tenant-api` in offerteknop-app;
  - `feature/offertes-koppeling` in dekoning-tegelwerken.
- Leg deze opdracht ongewijzigd vast in de docs van beide repo's.
- Commit in logische stappen en push.
- Werk het geheugen en de docs bij met wat Bob zelf nog moet doen: env-sleutels, nginx en eventuele DNS.
- Alles in de voorgrond uitvoeren.
- Niets systeembreed installeren, geen services starten, nginx niet aanraken.

---

## Akkoord van Bob op fase A (10 oktober 2026, chat, letterlijk)

> akkoord, dit is dus de eerste tegelzet klant op offerteknop. Dus word anders dan de schilders.
> Dit word de blueprint voor de volgende tegelzetters

Gevolg voor de bouw: het prijsboek en de bijbehorende editor zijn het rekenmodel van de
**branche tegelzetter** in Offerteknop (generiek, standaard voor elke nieuwe tegelzetter), niet
iets van De Koning alleen. De prijsvragen uit §3 zijn nog niet beantwoord; de bedragen worden
geladen zoals aangeleverd, met de aannames gemarkeerd (zie het fase B-rapport).
