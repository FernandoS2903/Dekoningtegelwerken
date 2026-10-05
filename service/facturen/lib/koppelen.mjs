// Koppelen van bunq-betalingen aan facturen.
//
// `score()` en `koppel()` zijn puur: geen database, geen netwerk. Daar hangt
// het geld aan, dus dat moet los te testen zijn.
//
// Scoreopbouw (uit de opdracht):
//   bedrag exact gelijk          0,40   verplicht; anders is de score 0
//   betaling > 7 dagen te vroeg     0   hard uitgesloten
//   IBAN leverancier == tegenrek. +0,40
//   factuurnummer/kenmerk in oms. +0,30
//   naam lijkt op tegenpartij     +0,20
// Maximaal 1,0.

import { alleenAlfanumeriek, dagenVerschil, gelijkenis, naarIban, normaliseerNaam } from './hulp.mjs';

export const BEDRAG_MARGE = 0.01;
export const DAGEN_TE_VROEG = 7;
export const NAAM_GELIJKENIS = 0.75;
export const KENMERK_MIN_LENGTE = 4;

// De datum waartegen "te vroeg" wordt gemeten: de factuurdatum, en anders de
// dag dat de mail binnenkwam.
function referentieDatum(factuur) {
  return factuur.factuurdatum || (factuur.ontvangen ? String(factuur.ontvangen).slice(0, 10) : null);
}

// Geeft { score, redenen } terug. `redenen` legt in het scherm uit waarom
// de zekerheid is wat hij is.
export function score(factuur, betaling) {
  const leeg = { score: 0, redenen: [] };

  const bedrag = Number(factuur.bedrag);
  const betaald = Number(betaling.bedrag);
  if (!Number.isFinite(bedrag) || !Number.isFinite(betaald)) return leeg;

  // Alleen uitgaande betalingen. Een creditnota (negatief bedrag) hoort bij
  // geld dat terugkomt en wordt dus nooit aan een uitgaande betaling gekoppeld.
  if (betaald >= 0) return leeg;

  if (Math.abs(-betaald - bedrag) > BEDRAG_MARGE) return leeg;

  const referentie = referentieDatum(factuur);
  if (referentie && betaling.datum) {
    const verschil = dagenVerschil(String(betaling.datum).slice(0, 10), referentie);
    if (verschil !== null && verschil < -DAGEN_TE_VROEG) return leeg;
  }

  let totaal = 0.4;
  const redenen = ['bedrag klopt exact'];

  const ibanFactuur = naarIban(factuur.iban);
  const ibanBetaling = naarIban(betaling.tegenrekening_iban);
  if (ibanFactuur && ibanBetaling && ibanFactuur === ibanBetaling) {
    totaal += 0.4;
    redenen.push('IBAN van de leverancier klopt');
  }

  const omschrijving = alleenAlfanumeriek(betaling.omschrijving);
  if (omschrijving) {
    for (const kenmerk of [factuur.factuurnummer, factuur.betalingskenmerk]) {
      const k = alleenAlfanumeriek(kenmerk);
      if (k.length >= KENMERK_MIN_LENGTE && omschrijving.includes(k)) {
        totaal += 0.3;
        redenen.push('kenmerk staat in de omschrijving');
        break;
      }
    }
  }

  const a = normaliseerNaam(factuur.leverancier);
  const b = normaliseerNaam(betaling.tegenpartij_naam);
  if (a && b) {
    const bevat = a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a));
    if (bevat || gelijkenis(factuur.leverancier, betaling.tegenpartij_naam) >= NAAM_GELIJKENIS) {
      totaal += 0.2;
      redenen.push('naam lijkt op de tegenpartij');
    }
  }

  return { score: Math.min(1, Math.round(totaal * 1000) / 1000), redenen };
}

// Greedy toewijzen: hoogste score eerst, elke factuur en elke betaling
// hoogstens één keer. Bij gelijke score eerst het kleinste datumverschil,
// daarna de laagste id's, zodat de uitkomst altijd dezelfde is.
export function koppel(facturen, betalingen) {
  const paren = [];
  for (const factuur of facturen) {
    for (const betaling of betalingen) {
      const { score: s, redenen } = score(factuur, betaling);
      if (s <= 0) continue;
      const referentie = referentieDatum(factuur);
      const afstand = referentie && betaling.datum
        ? Math.abs(dagenVerschil(String(betaling.datum).slice(0, 10), referentie) ?? 9999)
        : 9999;
      paren.push({ factuurId: factuur.id, betalingId: String(betaling.id), score: s, redenen, afstand });
    }
  }

  paren.sort((x, y) => (
    y.score - x.score
    || x.afstand - y.afstand
    || Number(x.factuurId) - Number(y.factuurId)
    || String(x.betalingId).localeCompare(String(y.betalingId))
  ));

  const gebruikteFacturen = new Set();
  const gebruikteBetalingen = new Set();
  const uit = [];
  for (const paar of paren) {
    if (gebruikteFacturen.has(paar.factuurId) || gebruikteBetalingen.has(paar.betalingId)) continue;
    gebruikteFacturen.add(paar.factuurId);
    gebruikteBetalingen.add(paar.betalingId);
    uit.push(paar);
  }
  return uit;
}

// Past de koppelingen toe op de database. Boven de drempel gaat de factuur
// automatisch op betaald (met de datum van de betaling); daaronder wordt het
// een suggestie die Bob met één klik bevestigt. Suggesties worden elke ronde
// opnieuw berekend, dus eerst de oude weg.
export function verwerk(opslag, drempel) {
  opslag.wisSuggesties();

  const facturen = opslag.openFacturenMetBedrag();
  const betalingen = opslag.vrijeBetalingen();
  const paren = koppel(facturen, betalingen);

  let betaald = 0;
  let suggesties = 0;

  for (const paar of paren) {
    const betaling = opslag.betaling(paar.betalingId);
    if (!betaling) continue;

    if (paar.score >= drempel) {
      opslag.zetBetaald(paar.factuurId, {
        betaald_op: betaling.datum ? String(betaling.datum).slice(0, 10) : null,
        betaald_via: 'bunq',
        bunq_betaling_id: paar.betalingId,
        match_score: paar.score,
      });
      opslag.log('info', `Automatisch op betaald gezet via bunq (zekerheid ${Math.round(paar.score * 100)}%: `
        + `${paar.redenen.join(', ')})`, paar.factuurId);
      betaald++;
    } else {
      opslag.zetSuggestie(paar.factuurId, paar.betalingId, paar.score);
      suggesties++;
    }
  }

  return { betaald, suggesties, bekeken: facturen.length, betalingen: betalingen.length };
}
