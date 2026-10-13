// Inkoopfacturen betalen via bunq: conceptbetalingen (DraftPayment) die de
// eigenaar in de bunq-app goedkeurt. Het portaal verplaatst zelf nooit geld.
// Opdracht en besluiten: docs/opdrachten/bunq-betalen.md.
//
// De volgorde bij het klaarzetten (aanmaken):
//  1. dezelfde formuliersleutel al gezien? Dan dat resultaat (dubbel klikken);
//  2. toegang: bunq ingesteld, betalen aan, rekening gekozen, ingelogd met
//     Microsoft (niet via break-glass of Basic Auth);
//  3. elke factuur opnieuw beoordelen (open, bedrag, geldig IBAN, geen
//     incasso, geen lopende draft) en het totaal tegen het maximum;
//  4. de vingerafdruk van wat op het bevestigingsscherm stond moet nog
//     kloppen, anders eerst opnieuw laten bevestigen;
//  5. nieuw of afwijkend IBAN: de bevestiging moet erbij zitten;
//  6. draft en regels vastleggen vóór het verzoek (unieke index: per factuur
//     hooguit één actieve draft), dan één POST naar bunq.
//
// Bekende IBAN's: een IBAN dat iemand bij het klaarzetten bevestigt is
// 'voorlopig'; pas als bunq meldt dat de draft is goedgekeurd wordt hij
// 'vertrouwd'. Wijkt het IBAN af van een vertrouwd IBAN van die leverancier,
// of hoort het al bij een andere leverancier, dan is het 'afwijkend' en moet
// je naast het vinkje de laatste vier tekens overtypen.

import crypto from 'node:crypto';
import { DRAFT_AFGEWEZEN, DubbeleDraft } from './betalen-opslag.mjs';
import { DraftFout } from './bunq.mjs';
import { euro, ibanGeldig, ibanLeesbaar, naarIban, normaliseerNaam, schoonTenaamstelling } from './hulp.mjs';

export const MAX_REGELS = 25;
export const OMSCHRIJVING_MAX = 140;
// Een draft met een onzeker antwoord zoeken we zo lang terug in de lijst van
// bunq; daarna geldt hij als mislukt en kan de factuur opnieuw.
export const ONZEKER_OPGEVEN_MS = 30 * 60 * 1000;
// Een draft die op 'bezig' bleef staan (dienst gestopt midden in het
// verzoek) behandelen we na zo lang als onzeker.
export const BEZIG_VERLOPEN_MS = 10 * 60 * 1000;

// Leesbare tekst bij een status van bunq of van ons.
export const DRAFT_TEKST = {
  bezig: 'wordt klaargezet',
  onzeker: 'onzeker of hij bij bunq is aangekomen',
  PENDING: 'klaargezet in bunq — keur goed in de app',
  ACCEPTED: 'goedgekeurd in bunq — wacht op de betaling',
  REJECTED: 'geweigerd in de bunq-app',
  CANCELLED: 'ingetrokken in bunq',
  mislukt: 'klaarzetten mislukt',
};
export const draftTekst = (status) => DRAFT_TEKST[status] || `status in bunq: ${status}`;

export function leverancierSleutel(factuur) {
  return normaliseerNaam(factuur.leverancier);
}

// De omschrijving op de betaling: het betalingskenmerk als dat er is (dan
// precies zoals op de factuur), anders factuurnummer en een korte naam.
export function omschrijvingVoor(factuur) {
  if (factuur.betalingskenmerk) return String(factuur.betalingskenmerk).trim().slice(0, OMSCHRIJVING_MAX);
  const naam = String(factuur.leverancier || '').trim().slice(0, 40);
  const delen = factuur.factuurnummer
    ? ['Factuur', String(factuur.factuurnummer).trim(), naam]
    : ['Factuur', naam, factuur.factuurdatum || ''];
  return delen.filter(Boolean).join(' ').slice(0, OMSCHRIJVING_MAX);
}

// De naam bij het IBAN: de tenaamstelling van de factuur, anders de leverancier.
export const naamVoor = (factuur) => schoonTenaamstelling(factuur.iban_naam) || String(factuur.leverancier || '').trim().slice(0, 120);

// Mag deze sessie überhaupt betalen? null = ja, anders de reden.
export function toegangReden({ inst, kader, bunq }) {
  if (!bunq || !bunq.beschikbaar) return 'bunq is niet ingesteld (BUNQ_API_KEY in de env).';
  if (!inst.betalenRekening) return 'Er is nog geen rekening gekozen om vanaf te betalen (Instellingen › Inkoopfacturen).';
  if (!inst.betalenAan) return 'Betalen via bunq staat uit (Instellingen › Inkoopfacturen).';
  if (kader?.modus === 'breakglass') return 'Betalen kan niet via de noodtoegang (break-glass). Log in met Microsoft.';
  if (kader?.modus !== 'sso') return 'Betalen kan alleen na inloggen met Microsoft.';
  return null;
}

// Hoe staat het IBAN van deze factuur ten opzichte van wat we kennen?
//   vertrouwd  eerder betaald en in de app goedgekeurd
//   nieuw      nog nooit gebruikt voor deze leverancier
//   afwijkend  anders dan het vertrouwde IBAN van deze leverancier, of al
//              vertrouwd voor een andere leverancier
export function ibanStatus(betaalOpslag, leverancier, iban) {
  const bekend = betaalOpslag.ibansVan(leverancier);
  const vertrouwd = bekend.filter((r) => r.status === 'vertrouwd');
  const andere = betaalOpslag.ibanBij(iban).filter((r) => r.leverancier !== leverancier && r.status === 'vertrouwd');
  let status = 'nieuw';
  if (vertrouwd.some((r) => r.iban === iban)) status = 'vertrouwd';
  else if (vertrouwd.length || andere.length) status = 'afwijkend';
  return {
    status,
    vertrouwd: vertrouwd.map((r) => r.iban),
    andereLeveranciers: [...new Set(andere.map((r) => r.naam || r.leverancier))],
  };
}

// Kan deze factuur in een conceptbetaling? Geeft {kan, redenen, regel, iban, actief}.
export function beoordeelFactuur(factuur, { inst, betaalOpslag }) {
  const redenen = [];
  const actief = betaalOpslag.actieveRegel(factuur.id);
  const iban = naarIban(factuur.iban);

  if (factuur.status === 'betaald') redenen.push('Deze factuur is al betaald.');
  else if (factuur.status !== 'open') redenen.push('Deze factuur staat op genegeerd.');
  if (actief) redenen.push(`Er loopt al een conceptbetaling (${draftTekst(actief.status)}).`);
  if (!['ok', 'handmatig'].includes(factuur.uitlees_status)) redenen.push('De factuur is nog niet (goed) uitgelezen.');
  if (factuur.betaalwijze === 'incasso') redenen.push('Volgens de factuur wordt dit bedrag geïncasseerd; dan niet zelf overmaken.');
  if (factuur.betaalwijze === 'al_betaald') redenen.push('Volgens de factuur is er al betaald.');
  if (!factuur.leverancier) redenen.push('De leverancier ontbreekt; vul die in bij "Gegevens corrigeren".');

  const bedrag = factuur.bedrag === null || factuur.bedrag === undefined ? null : Number(factuur.bedrag);
  if (bedrag === null || !Number.isFinite(bedrag)) redenen.push('Het bedrag ontbreekt; vul het in bij "Gegevens corrigeren".');
  else if (bedrag <= 0) redenen.push('Een creditnota of nulbedrag betaal je niet.');
  else if (Math.round(bedrag * 100) / 100 !== bedrag) redenen.push('Het bedrag heeft meer dan twee decimalen; controleer het bij "Gegevens corrigeren".');
  else if (bedrag > inst.betalenMax) redenen.push(`Het bedrag is hoger dan het maximum per conceptbetaling (${euro(inst.betalenMax)}).`);
  if (factuur.valuta && factuur.valuta !== 'EUR') redenen.push(`Alleen euro's; deze factuur is in ${factuur.valuta}.`);
  else if (!factuur.valuta) redenen.push('De valuta ontbreekt; vul EUR in bij "Gegevens corrigeren" als dat klopt.');

  if (!iban) redenen.push('Het IBAN ontbreekt; vul het in bij "Gegevens corrigeren".');
  else if (!ibanGeldig(iban)) redenen.push(`IBAN ${ibanLeesbaar(iban)} klopt niet (controlegetal); controleer het bij "Gegevens corrigeren".`);
  else if (inst.betalenRekening?.iban && naarIban(inst.betalenRekening.iban) === iban) redenen.push('Dit IBAN is de eigen rekening waarvan betaald wordt.');

  const leverancier = leverancierSleutel(factuur);
  const ibanInfo = iban && leverancier ? ibanStatus(betaalOpslag, leverancier, iban) : null;
  const regel = {
    factuurId: factuur.id,
    leverancier,
    bedrag,
    iban,
    naam: naamVoor(factuur),
    omschrijving: omschrijvingVoor(factuur),
  };
  return { kan: redenen.length === 0, redenen, regel, iban: ibanInfo, actief };
}

// Een vingerafdruk van wat op het bevestigingsscherm stond. Verandert er
// tussen tonen en versturen iets (bedrag, IBAN, rekening, status van het
// IBAN), dan klopt hij niet meer en moet je opnieuw bevestigen.
export function vingerafdruk(beoordelingen, rekeningId) {
  const inhoud = beoordelingen.map((b) => [
    b.regel.factuurId, Number(b.regel.bedrag).toFixed(2), b.regel.iban, b.regel.naam, b.regel.omschrijving, b.iban?.status || '',
  ]);
  return crypto.createHash('sha256').update(JSON.stringify([String(rekeningId), inhoud])).digest('hex').slice(0, 32);
}

// Welke bevestigingen ontbreken er in het formulier? Lijst met teksten.
export function ontbrekendeBevestigingen(beoordelingen, body) {
  const ontbreekt = [];
  for (const b of beoordelingen) {
    const id = b.regel.factuurId;
    const status = b.iban?.status;
    if (status === 'nieuw' && body.get(`nieuw_${id}`) !== '1') {
      ontbreekt.push(`Bevestig het nieuwe IBAN van ${b.regel.naam}.`);
    }
    if (status === 'afwijkend') {
      const vier = String(body.get(`laatste4_${id}`) || '').replace(/\s+/g, '').toUpperCase();
      if (body.get(`afwijkend_${id}`) !== '1' || vier !== b.regel.iban.slice(-4)) {
        ontbreekt.push(`Het IBAN van ${b.regel.naam} wijkt af: vink de controle aan en typ de laatste vier tekens van het IBAN over.`);
      }
    }
  }
  return ontbreekt;
}

export function maakBetaler({ opslag, betaalOpslag, bunq, klok = () => Date.now() }) {
  const nu = () => new Date(klok()).toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Alles wat het bevestigingsscherm nodig heeft.
  function voorbereiden(ids, { inst, kader }) {
    const toegang = toegangReden({ inst, kader, bunq });
    const uniek = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const facturen = uniek.map((id) => opslag.factuur(id)).filter(Boolean);
    const beoordelingen = facturen.map((f) => ({ factuur: f, ...beoordeelFactuur(f, { inst, betaalOpslag }) }));
    const totaal = Math.round(beoordelingen.reduce((s, b) => s + (b.kan ? b.regel.bedrag : 0), 0) * 100) / 100;
    const problemen = [];
    if (!facturen.length) problemen.push('Kies minstens één factuur.');
    if (facturen.length > MAX_REGELS) problemen.push(`Hooguit ${MAX_REGELS} facturen in één conceptbetaling.`);
    if (totaal > inst.betalenMax) problemen.push(`Het totaal (${euro(totaal)}) is hoger dan het maximum per conceptbetaling (${euro(inst.betalenMax)}). Kies minder facturen.`);
    const kan = !toegang && !problemen.length && beoordelingen.length > 0 && beoordelingen.every((b) => b.kan);
    return {
      toegang, problemen, beoordelingen, totaal, kan,
      rekening: inst.betalenRekening,
      vingerafdruk: vingerafdruk(beoordelingen, inst.betalenRekening?.id || ''),
    };
  }

  // Zet de conceptbetaling klaar. Geeft {uitkomst, draftId?, meldingen?}:
  //   klaar | al (zelfde sleutel) | geweigerd | gewijzigd | bevestigen |
  //   dubbel | mislukt (bunq weigerde) | onzeker (antwoord kwijt)
  async function aanmaken({ ids, sleutel, afdruk, body, inst, kader }) {
    const door = kader?.email || 'onbekend';
    if (!/^[A-Za-z0-9-]{16,64}$/.test(String(sleutel || ''))) {
      return { uitkomst: 'geweigerd', meldingen: ['Het formulier is niet compleet; open het bevestigingsscherm opnieuw.'] };
    }
    const eerder = betaalOpslag.draftMetSleutel(sleutel);
    if (eerder) return { uitkomst: 'al', draftId: eerder.id };

    const v = voorbereiden(ids, { inst, kader });
    if (v.toegang) return { uitkomst: 'geweigerd', meldingen: [v.toegang] };
    if (!v.kan) {
      return {
        uitkomst: 'geweigerd',
        meldingen: [...v.problemen, ...v.beoordelingen.flatMap((b) => b.redenen.map((r) => `${b.regel.naam || 'Factuur'}: ${r}`))],
      };
    }
    if (afdruk !== v.vingerafdruk) {
      return { uitkomst: 'gewijzigd', meldingen: ['Er is iets veranderd sinds het bevestigingsscherm (bedrag, IBAN, rekening of status). Controleer het opnieuw.'] };
    }
    const ontbreekt = ontbrekendeBevestigingen(v.beoordelingen, body);
    if (ontbreekt.length) return { uitkomst: 'bevestigen', meldingen: ontbreekt };

    const regels = v.beoordelingen.map((b) => b.regel);
    let draftId;
    try {
      draftId = betaalOpslag.reserveer({
        sleutel, rekeningId: v.rekening.id, rekeningIban: v.rekening.iban, regels, door, nu: nu(),
      });
    } catch (fout) {
      if (fout instanceof DubbeleDraft) return { uitkomst: 'dubbel', meldingen: [fout.message] };
      throw fout;
    }

    const rekeningKort = v.rekening.iban ? '…' + v.rekening.iban.slice(-4) : v.rekening.id;
    for (const b of v.beoordelingen) {
      if (b.iban && b.iban.status !== 'vertrouwd') {
        betaalOpslag.bevestigIban({
          leverancier: b.regel.leverancier, naam: b.factuur.leverancier, iban: b.regel.iban,
          ibanNaam: schoonTenaamstelling(b.factuur.iban_naam), door, nu: nu(),
        });
        opslag.log('warn', `${b.iban.status === 'afwijkend' ? 'Afwijkend' : 'Nieuw'} IBAN ${ibanLeesbaar(b.regel.iban)} bevestigd bij het klaarzetten`
          + (b.iban.vertrouwd.length ? ` (bekend was: ${b.iban.vertrouwd.map(ibanLeesbaar).join(', ')})` : '')
          + (b.iban.andereLeveranciers.length ? ` (ook bekend bij: ${b.iban.andereLeveranciers.join(', ')})` : '')
          + '.', b.factuur.id, door);
      }
    }

    try {
      const { id: bunqId } = await bunq.maakDraft({ rekeningId: v.rekening.id, regels });
      betaalOpslag.zetDraft(draftId, { status: 'PENDING', bunqId, nu: nu() });
      for (const r of regels) {
        opslag.log('info', `Conceptbetaling klaargezet in bunq: ${euro(r.bedrag)} naar ${ibanLeesbaar(r.iban)} (${r.naam}), `
          + `omschrijving "${r.omschrijving}", van rekening ${rekeningKort}, draft ${bunqId}. Keur goed in de bunq-app.`, r.factuurId, door);
      }
      return { uitkomst: 'klaar', draftId };
    } catch (fout) {
      const zeker = fout instanceof DraftFout ? fout.zeker : false;
      betaalOpslag.zetDraft(draftId, { status: zeker ? 'mislukt' : 'onzeker', fout: fout.message, nu: nu() });
      for (const r of regels) {
        opslag.log(zeker ? 'error' : 'warn', zeker
          ? `Conceptbetaling klaarzetten mislukt: ${fout.message}`
          : `Onzeker of de conceptbetaling bij bunq is aangekomen (${fout.message}). De volgende synchronisatie zoekt hem op; zet hem niet opnieuw klaar.`,
        r.factuurId, door);
      }
      return { uitkomst: zeker ? 'mislukt' : 'onzeker', draftId, meldingen: [fout.message] };
    }
  }

  // De stand van lopende drafts bijwerken (in de sync-ronde).
  async function bijwerken() {
    if (!bunq || !bunq.beschikbaar) return { overgeslagen: 'bunq niet ingesteld' };
    const lopend = betaalOpslag.lopendeDrafts();
    let gewijzigd = 0;
    const lijsten = new Map();

    for (const draft of lopend) {
      const leeftijd = klok() - Date.parse(draft.aangemaakt_op);
      if (draft.status === 'bezig' && !(leeftijd > BEZIG_VERLOPEN_MS)) continue;

      if (draft.status === 'bezig' || draft.status === 'onzeker') {
        // Zoeken in de recente drafts van de rekening: dezelfde regels, en
        // een bunq-id dat nog bij geen enkele draft van ons hoort.
        if (!lijsten.has(draft.rekening_id)) lijsten.set(draft.rekening_id, await bunq.drafts(draft.rekening_id));
        const bekend = betaalOpslag.bekendeBunqIds();
        const regels = betaalOpslag.regels(draft.id);
        const gevonden = lijsten.get(draft.rekening_id).find((d) => !bekend.has(d.id) && zelfdeRegels(d.regels, regels));
        if (gevonden) {
          betaalOpslag.zetDraft(draft.id, { status: gevonden.status, bunqId: gevonden.id, bunqBijgewerkt: gevonden.bijgewerkt, fout: null, nu: nu() });
          logDraft(regels, 'info', `Conceptbetaling teruggevonden in bunq (draft ${gevonden.id}): ${draftTekst(gevonden.status)}.`);
          if (gevonden.status === 'ACCEPTED') verwerkGoedkeuring(draft.id, gevonden);
          gewijzigd++;
        } else if (leeftijd > ONZEKER_OPGEVEN_MS) {
          betaalOpslag.zetDraft(draft.id, { status: 'mislukt', fout: 'niet teruggevonden in bunq', nu: nu() });
          logDraft(regels, 'warn', 'Conceptbetaling niet teruggevonden in bunq; geldt als mislukt. Controleer de bunq-app en zet hem zo nodig opnieuw klaar.');
          gewijzigd++;
        }
        continue;
      }

      if (!draft.bunq_id) continue;
      const stand = await bunq.draft(draft.rekening_id, draft.bunq_id);
      if (stand.status === draft.status) continue;
      betaalOpslag.zetDraft(draft.id, { status: stand.status, bunqBijgewerkt: stand.bijgewerkt, fout: null, nu: nu() });
      const regels = betaalOpslag.regels(draft.id);
      logDraft(regels, DRAFT_AFGEWEZEN.includes(stand.status) ? 'warn' : 'info',
        `Conceptbetaling ${draft.bunq_id}: ${draftTekst(stand.status)}.`
        + (DRAFT_AFGEWEZEN.includes(stand.status) ? ' De factuur kan opnieuw worden klaargezet.' : ''));
      if (stand.status === 'ACCEPTED') verwerkGoedkeuring(draft.id, stand);
      gewijzigd++;
    }
    return { lopend: lopend.length, gewijzigd };
  }

  function logDraft(regels, niveau, tekst) {
    for (const r of regels) opslag.log(niveau, tekst, r.factuur_id);
  }

  // Goedgekeurd: de IBAN's worden vertrouwd en de betaal-id's uit bunq
  // komen bij de regels (op IBAN en bedrag), voor het koppelen.
  function verwerkGoedkeuring(draftId, stand) {
    const regels = betaalOpslag.regels(draftId);
    const vrij = [...stand.betalingen];
    for (const r of regels) {
      betaalOpslag.vertrouwIban(r.leverancier, r.iban, nu());
      const i = vrij.findIndex((b) => b.iban === r.iban && Math.abs(b.bedrag - r.bedrag) < 0.005);
      if (i >= 0) {
        betaalOpslag.zetBetalingId(r.id, vrij[i].id);
        vrij.splice(i, 1);
      }
    }
  }

  // Facturen waarvan de goedgekeurde draft een betaal-id gaf: zodra die
  // betaling in de bunq-betalingen staat, de factuur op betaald zetten. Het
  // gewone koppelen (koppelen.mjs) vangt de rest op.
  function koppelGoedgekeurde() {
    let betaald = 0;
    for (const r of betaalOpslag.goedgekeurdeRegels()) {
      const factuur = opslag.factuur(r.factuur_id);
      if (!factuur || factuur.status !== 'open') continue;
      const betaling = opslag.betaling(r.betaling_id);
      if (!betaling || betaling.gekoppelde_factuur_id) continue;
      if (Math.abs(Math.abs(Number(betaling.bedrag)) - Number(r.bedrag)) >= 0.005) continue;
      opslag.zetBetaald(factuur.id, {
        betaald_op: betaling.datum ? String(betaling.datum).slice(0, 10) : null,
        betaald_via: 'bunq',
        bunq_betaling_id: betaling.id,
        match_score: 1,
      });
      opslag.log('info', `Op betaald gezet: betaling ${betaling.id} hoort bij de goedgekeurde conceptbetaling ${r.bunq_id}.`, factuur.id);
      betaald++;
    }
    return betaald;
  }

  return { voorbereiden, aanmaken, bijwerken, koppelGoedgekeurde };
}

// Zijn de regels van een draft in bunq dezelfde als die van ons? Op IBAN,
// bedrag en omschrijving, ongeacht de volgorde.
export function zelfdeRegels(bunqRegels, onzeRegels) {
  if (bunqRegels.length !== onzeRegels.length) return false;
  const sleutel = (iban, bedrag, oms) => `${iban}|${Number(bedrag).toFixed(2)}|${String(oms).trim()}`;
  const a = bunqRegels.map((r) => sleutel(r.iban, r.bedrag, r.omschrijving)).sort();
  const b = onzeRegels.map((r) => sleutel(r.iban, r.bedrag, r.omschrijving)).sort();
  return a.every((x, i) => x === b[i]);
}

