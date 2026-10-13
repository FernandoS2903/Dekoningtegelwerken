# Opdracht: inkoopfacturen betalen via bunq (portaal cms.dekoningtegelwerken.nl)

Leg deze opdracht in fase B ongewijzigd vast in `docs/opdrachten/bunq-betalen.md`.

## Vraag van Bob (13 okt 2026)

"Ik wil de facturen ook direct kunnen betalen via Bunq." Het gaat om de pagina Inkoopfacturen (`/facturen/`) en het factuurpaneel in het portaal. Nu koppelt het portaal alleen alleen-lezend aan bunq (uitgaande betalingen matchen met facturen).

## Voorgestelde aanpak (ter toetsing in fase A, niet vastgelegd)

1. **Concept-betaling, geen directe betaling.** Het portaal maakt via de bunq API een *DraftPayment* aan (`POST /user/{id}/monetary-account/{id}/draft-payment`, `number_of_required_accepts: 1`). De eigenaar keurt die goed in de bunq-app (pincode/biometrie). Het portaal verplaatst zelf nooit geld. Reden: als het portaal of de env-sleutel ooit gelekt wordt, kan er zonder goedkeuring in de app geen euro weg. Controleer in fase A tegen de actuele bunq-documentatie: endpoint, velden, statussen (PENDING/ACCEPTED/REJECTED/CANCELLED), of request signing voor deze POST verplicht is, en of één draft meerdere regels kan bevatten (voor "selectie betalen").
2. **Knop "Betalen via bunq"** in het factuurpaneel bij open en verlopen facturen, plus optioneel meervoudige selectie in de lijst ("Geselecteerde betalen", één draft met meerdere regels). Bevestigingsscherm vóór aanmaken met: leverancier, IBAN (+ tenaamstelling), bedrag, omschrijving, van-rekening. Na aanmaken: status "Klaargezet in bunq — keur goed in de app".
3. **Gegevens:** bedrag en IBAN uit het uitlezen door Claude; omschrijving = betalingskenmerk als dat er is, anders factuurnummer (+ korte leveranciersnaam). Ontbreekt IBAN of bedrag → knop uit met uitleg, handmatig invullen mogelijk (met IBAN mod-97-controle).
4. **Fraudebescherming (factuurfraude met gewijzigd IBAN):** per leverancier een bekend/vertrouwd IBAN vastleggen (eerste betaling = expliciete bevestiging "nieuw IBAN"). Wijkt het IBAN op een factuur af van het bekende IBAN → duidelijke waarschuwing en extra bevestiging; nooit stil overnemen.
5. **Dubbel betalen voorkomen:** per factuur hooguit één actieve draft (PENDING); idempotent server-side; geen draft voor facturen die al betaald/gekoppeld zijn. Statussen van drafts bijwerken in de sync-ronde; ACCEPTED → wachten op de echte betaling, die de bestaande koppellogica matcht (draft-id/omschrijving als extra matchsignaal). REJECTED/CANCELLED → opnieuw mogelijk.
6. **Instellingen:** schakelaar "Betalen via bunq" (standaard uit), keuze van-rekening (monetary account), maximumbedrag per draft (standaard bijv. € 5.000). Alles gelogd in het logboek (wie, wanneer, welke factuur, draft-id, bedrag; geen sleutels).
7. **Toegang:** alleen met SSO-sessie; niet via break-glass (voorstel, ter beslissing door Bob). CSRF en herkomstcontrole zoals bestaand.
8. **Tests** met nagebootste bunq (geen netwerk), browsertests op 360/390/1440 voor knop, bevestiging en selectie. In fase B géén echte draft aanmaken.

## Fase A — alleen inventaris en plan, daarna STOPPEN

Lees CLAUDE.md en docs/GEHEUGEN.md. Breng in kaart en rapporteer kort en concreet:
- Hoe `lib/bunq.mjs` nu werkt (sessie, sleutel, signing, welke endpoints) en wat er nodig is voor een POST naar draft-payment. Is de bunq-sleutel in productie al ingesteld en draait de koppeling (zie journal/logboek, alleen-lezen kijken, geen secrets tonen)? De sync toont "1 betalingen".
- Of het uitlezen door Claude nu IBAN, tenaamstelling en betalingskenmerk teruggeeft en of die in de database staan; zo niet, wat er moet veranderen (schema, prompt) en of bestaande facturen opnieuw uitgelezen moeten worden.
- Welke rekening(en) (monetary accounts) er zijn, alleen ID/omschrijving, geen saldo.
- Benodigde schemawijziging (versie 7?), routes, schermen, instellingen.
- Risico's en de open vragen voor Bob (o.a. draft vs. direct, selectie wel/niet, maximumbedrag, break-glass, wat bij ontbrekend IBAN).
- Plan voor fase B (branch `feature/bunq-betalen` vanaf `main`) en fase C (uitrol, eerste proef met een klein bedrag door Bob zelf).

Wijzig in fase A niets, maak geen branch, roep bunq niet schrijvend aan. Sluit af met het rapport en stop.

---

## Antwoorden van Bob op fase A (13 okt 2026, 18:56)

"Akkoord op alle openstaande vragen" — dus de adviezen uit fase A gelden:

1. Draft (conceptbetaling), geen directe betaling.
2. Selectie betalen bouwen we nu ook (één draft, meerdere entries).
3. Maximum € 5.000 per draft (instelbaar).
4. Break-glass-sessies kunnen niet betalen.
5. Ontbrekend IBAN/bedrag handmatig invullen mag, met mod-97 en verplichte bevestiging "nieuw IBAN".
6. Welke rekening zakelijk is, is nog NIET beantwoord: maak de van-rekening een keuze in Instellingen (alleen bankrekeningen, geen spaar), zonder voorkeuze; betalen blijft uit tot er een rekening gekozen is. BUNQ_ACCOUNT_IBANS laat je ongemoeid (env doet Bob in fase C); noem het in het rapport.
7. Open facturen opnieuw uitlezen voor tenaamstelling en betaalwijze mag — maar NIET in productie in fase B. Bouw het als eenmalige CLI/knop (alleen open facturen zonder iban_naam) die Bob in fase C draait.
8. Intrekken van drafts vanuit het portaal: niet bouwen; alleen weigeren in de bunq-app.

Fase B: branch `feature/bunq-betalen` vanaf `main` (worktree). Geen echte draft, geen schrijvende bunq-aanroep, geen productiewijziging (database, env, dienst). Alle tests groen, browsertests 360/390/1440. GEHEUGEN.md bijwerken met de stand en een concreet fase C-stappenplan (incl. proefdraft € 0,01, en `rm -rf /tmp/bunqdoc` als opruimpunt voor Bob). Branch pushen, niet mergen.
