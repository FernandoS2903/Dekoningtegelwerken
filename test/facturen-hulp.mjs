// Gedeelde hulp voor de tests van het factuurdashboard.
// Geen testbestand zelf (geen .test.mjs), dus `node --test test/*.test.mjs`
// draait hem niet apart.

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maakOpslag, openDatabase } from '../service/facturen/lib/db.mjs';

const opruimen = [];

// Een verse database in een tijdelijke map, met de pdf-map ernaast.
export function tijdelijkeOpslag() {
  const map = mkdtempSync(path.join(os.tmpdir(), 'dekoning-facturen-test-'));
  opruimen.push(map);
  const opslag = maakOpslag(openDatabase(path.join(map, 'facturen.db')));
  return { opslag, map, pdfMap: path.join(map, 'pdfs') };
}

export function ruimOp() {
  while (opruimen.length) {
    try {
      rmSync(opruimen.pop(), { recursive: true, force: true });
    } catch { /* al weg */ }
  }
}

// Een factuur met alles ingevuld; velden zijn per test te overschrijven.
export function voegFactuurToe(opslag, {
  message_id = 'mail-1',
  attachment_id = 'bijlage-1',
  ontvangen = '2026-10-01T09:00:00Z',
  afzender_naam = 'Tegelhandel Zuid',
  afzender_email = 'facturen@tegelhandelzuid.nl',
  onderwerp = 'Factuur 2026-0123',
  uitlees_status = 'ok',
  ...velden
} = {}) {
  const { id } = opslag.voegFactuurToe({
    message_id, attachment_id, ontvangen, afzender_naam, afzender_email, onderwerp,
  });
  opslag.zetUitgelezen(id, uitlees_status, {
    leverancier: 'Tegelhandel Zuid B.V.',
    factuurnummer: '2026-0123',
    factuurdatum: '2026-10-01',
    vervaldatum: '2026-10-31',
    bedrag: 1210,
    valuta: 'EUR',
    iban: 'NL91ABNA0417164300',
    betalingskenmerk: null,
    omschrijving: 'XXL tegels',
    ...velden,
  });
  return opslag.factuur(id);
}

export function voegBetalingToe(opslag, {
  id = '501',
  datum = '2026-10-05',
  bedrag = -1210,
  tegenrekening_iban = 'NL91ABNA0417164300',
  tegenpartij_naam = 'Tegelhandel Zuid B.V.',
  omschrijving = 'Factuur 2026-0123',
  ...rest
} = {}) {
  opslag.voegBetalingToe({
    id, rekening_id: '1', rekening_iban: 'NL00BUNQ0000000001', valuta: 'EUR',
    datum, bedrag, tegenrekening_iban, tegenpartij_naam, omschrijving, ...rest,
  });
  return opslag.betaling(id);
}

// Een nagebootste Graph die onthoudt wat eruit zou zijn gegaan.
// `mails`, `bijlagen` (per message_id) en `tekst` (per message_id) zijn er
// voor de sync-ronde; zonder die argumenten is de mailbox leeg.
export function nepGraph({
  beschikbaar = true, faalt = false, mails = [], bijlagen = {}, tekst = {},
} = {}) {
  const verstuurd = [];
  const categorieen = [];
  return {
    beschikbaar,
    verstuurd,
    categorieen,
    async mails({ bekend = new Set() } = {}) {
      return mails.filter((m) => !bekend.has(m.id));
    },
    async pdfBijlagen(messageId) { return bijlagen[messageId] || []; },
    async mailTekst(messageId) { return tekst[messageId] || ''; },
    async mapInfo() { return { id: 'map-1', naam: 'Facturen' }; },
    async stuurDoor(messageId, { commentaar, naar }) {
      if (faalt) throw new Error('Graph is stuk');
      verstuurd.push({ messageId, commentaar, naar });
    },
    async voegCategorieToe(messageId, categorie) {
      categorieen.push({ messageId, categorie });
      return true;
    },
    async test() { return { ok: beschikbaar, melding: 'nep' }; },
  };
}

// Een nagebootste fetch die antwoorden uit een lijst geeft en de verzoeken
// bewaart. Elk antwoord is {status, json} of {status, tekst}.
export function nepFetch(antwoorden) {
  const verzoeken = [];
  const rij = [...antwoorden];
  const fn = async (url, opties = {}) => {
    verzoeken.push({ url, opties, body: opties.body });
    const volgend = rij.length > 1 ? rij.shift() : rij[0];
    if (!volgend) throw new Error('nepFetch: geen antwoord meer voor ' + url);
    const status = volgend.status ?? 200;
    const tekst = volgend.tekst ?? JSON.stringify(volgend.json ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (naam) => (volgend.headers || {})[String(naam).toLowerCase()] ?? null },
      async text() { return tekst; },
      async json() { return JSON.parse(tekst); },
      clone() { return this; },
    };
  };
  fn.verzoeken = verzoeken;
  return fn;
}
