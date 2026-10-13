// Betalen via bunq: conceptbetalingen klaarzetten, de controles daarvoor en
// het bijwerken van de stand. bunq is nagebootst; er gaat niets naar buiten
// en er wordt geen echte draft gemaakt.
//   node --test test/facturen-betalen.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  DraftFout, PRODUCTIE_URL, draftLichaam, maakBunq, maakSleutelpaar, naarDraft, verifieerLichaam,
} from '../service/facturen/lib/bunq.mjs';
import { maakBetaalOpslag, DubbeleDraft } from '../service/facturen/lib/betalen-opslag.mjs';
import {
  ONZEKER_OPGEVEN_MS, beoordeelFactuur, maakBetaler, omschrijvingVoor, toegangReden, zelfdeRegels,
} from '../service/facturen/lib/betalen.mjs';
import { ibanGeldig, ibanLeesbaar } from '../service/facturen/lib/hulp.mjs';
import { SCHEMA_VERSIE, maakOpslag, openDatabase } from '../service/facturen/lib/db.mjs';
import * as instellingen from '../service/facturen/lib/instellingen.mjs';
import { maakFacturenApp } from '../service/facturen/server.mjs';
import { nepBunq, nepFetch, ruimOp, tijdelijkeOpslag, voegBetalingToe, voegFactuurToe } from './facturen-hulp.mjs';

after(ruimOp);

const IBAN_A = 'NL91ABNA0417164300';
const IBAN_B = 'NL20INGB0001234567';
const IBAN_C = 'NL39RABO0300065264';
const SSO = { modus: 'sso', email: 'bob@voorbeeld.nl', naam: 'Bob', csrf: 'x' };

// Een opslag met betalen aan en rekening 42 gekozen.
function opzet({ max = '5000', aan = true } = {}) {
  const { opslag, map, pdfMap } = tijdelijkeOpslag();
  instellingen.bewaar(opslag, {
    betalen_rekening_id: '42', betalen_rekening_iban: 'NL00BUNQ0000000042', betalen_rekening_naam: 'Zakelijk',
    betalen_aan: aan ? '1' : '0', betalen_max: max,
  });
  const betaalOpslag = maakBetaalOpslag(opslag.db);
  return { opslag, map, pdfMap, betaalOpslag, inst: () => instellingen.lees(opslag) };
}

const body = (velden = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(velden)) for (const w of [].concat(v)) p.append(k, w);
  return p;
};

// -- IBAN, omschrijving en de body voor bunq --------------------------------

test('IBAN: het controlegetal (mod 97) vangt tikfouten af', () => {
  for (const goed of [IBAN_A, IBAN_B, IBAN_C, 'nl91 abna 0417 1643 00', 'DE89370400440532013000']) assert.equal(ibanGeldig(goed), true, goed);
  assert.equal(ibanGeldig('NL91ABNA0417164301'), false, 'laatste cijfer anders');
  assert.equal(ibanGeldig('NL91ABNA0417613400'), false, 'cijfers verwisseld');
  assert.equal(ibanGeldig('NL91ABNA041716430'), false, 'te kort voor NL');
  assert.equal(ibanGeldig(''), false);
  assert.equal(ibanLeesbaar(IBAN_A), 'NL91 ABNA 0417 1643 00');
});

test('omschrijving: kenmerk als het er is, anders factuurnummer en naam; nooit langer dan 140', () => {
  assert.equal(omschrijvingVoor({ betalingskenmerk: ' 1234 5678 9012 3456 ', factuurnummer: 'F-1', leverancier: 'X' }), '1234 5678 9012 3456');
  assert.equal(omschrijvingVoor({ betalingskenmerk: null, factuurnummer: '2026-0123', leverancier: 'Tegelhandel Zuid B.V.' }), 'Factuur 2026-0123 Tegelhandel Zuid B.V.');
  assert.equal(omschrijvingVoor({ leverancier: 'Bouwmaat', factuurdatum: '2026-10-01' }), 'Factuur Bouwmaat 2026-10-01');
  assert.ok(omschrijvingVoor({ betalingskenmerk: 'x'.repeat(300) }).length <= 140);
});

test('de body van een draft: entries met IBAN-alias, bedrag met twee decimalen, één goedkeuring', () => {
  const lichaam = draftLichaam([
    { bedrag: 1210, iban: IBAN_A, naam: 'Tegelhandel Zuid B.V.', omschrijving: 'Factuur 2026-0123' },
    { bedrag: 89.9, iban: IBAN_B, naam: 'Van Dijk', omschrijving: 'y'.repeat(200) },
  ]);
  assert.equal(lichaam.number_of_required_accepts, 1);
  assert.deepEqual(lichaam.entries[0], {
    amount: { value: '1210.00', currency: 'EUR' },
    counterparty_alias: { type: 'IBAN', value: IBAN_A, name: 'Tegelhandel Zuid B.V.' },
    description: 'Factuur 2026-0123',
  });
  assert.equal(lichaam.entries[1].amount.value, '89.90');
  assert.equal(lichaam.entries[1].description.length, 140);
  assert.equal(lichaam.status, undefined, 'geen status meesturen');
});

test('naarDraft leest status, regels en de betaal-id\'s uit Payment en PaymentBatch', () => {
  const los = naarDraft({
    id: 77, status: 'accepted', updated: '2026-10-14 10:00:00',
    entries: [{ amount: { value: '12.50' }, counterparty_alias: { iban: IBAN_A }, description: 'a' }],
    object: { Payment: { id: 5001, amount: { value: '-12.50' }, counterparty_alias: { iban: IBAN_A } } },
  });
  assert.equal(los.status, 'ACCEPTED');
  assert.deepEqual(los.regels, [{ iban: IBAN_A, bedrag: 12.5, omschrijving: 'a' }]);
  assert.deepEqual(los.betalingen, [{ id: '5001', iban: IBAN_A, bedrag: 12.5 }]);

  const batch = naarDraft({
    id: 78, status: 'ACCEPTED', entries: [],
    object: { PaymentBatch: { payments: { Payment: [
      { id: 6001, amount: { value: '-1.00' }, counterparty_alias: { iban: IBAN_A } },
      { id: 6002, amount: { value: '-2.00' }, counterparty_alias: { label_monetary_account: { iban: IBAN_B } } },
    ] } } },
  });
  assert.deepEqual(batch.betalingen.map((b) => b.id), ['6001', '6002']);
  assert.equal(batch.betalingen[1].iban, IBAN_B);
  assert.equal(naarDraft({ id: 1, status: 'PENDING' }).betalingen.length, 0);
});

// -- lib/bunq.mjs: één ondertekende POST, nooit opnieuw -----------------------

// Een bunq-state met een geldige sessie, zodat er alleen het draftverzoek is.
function staatMetSessie(map, apiKey) {
  const { privateKey, publicKey } = maakSleutelpaar();
  const statePad = path.join(map, 'bunq_state.json');
  writeFileSync(statePad, JSON.stringify({
    privateKey, publicKey, installationToken: 'i', apparaatOk: true, sessieToken: 'sessie', userId: '7',
    apiKeyAfdruk: crypto.createHash('sha256').update(apiKey).digest('hex'),
  }));
  return { statePad, publicKey };
}

test('maakDraft: één ondertekende POST naar draft-payment, met het id terug', async () => {
  const { map } = tijdelijkeOpslag();
  const { statePad, publicKey } = staatMetSessie(map, 'sleutel');
  const fetchFn = nepFetch([{ json: { Response: [{ Id: { id: 4242 } }] } }]);
  const bunq = maakBunq({ apiKey: 'sleutel', statePad, fetch: fetchFn });

  const uit = await bunq.maakDraft({ rekeningId: '42', regels: [{ bedrag: 10, iban: IBAN_A, naam: 'A', omschrijving: 'x' }] });
  assert.deepEqual(uit, { id: '4242' });
  assert.equal(fetchFn.verzoeken.length, 1);
  const [v] = fetchFn.verzoeken;
  assert.equal(v.url, PRODUCTIE_URL + '/user/7/monetary-account/42/draft-payment');
  assert.equal(v.opties.method, 'POST');
  assert.equal(v.opties.headers['x-bunq-client-authentication'], 'sessie');
  assert.equal(verifieerLichaam(publicKey, v.body, v.opties.headers['x-bunq-client-signature']), true, 'handtekening over de body');
  assert.equal(JSON.parse(v.body).number_of_required_accepts, 1);
});

test('maakDraft: bij een 5xx of time-out geen tweede poging, en de fout is "onzeker"', async () => {
  const { map } = tijdelijkeOpslag();
  const { statePad } = staatMetSessie(map, 'sleutel');
  const regels = [{ bedrag: 10, iban: IBAN_A, naam: 'A', omschrijving: 'x' }];

  const vijf = nepFetch([{ status: 503, tekst: 'weg' }]);
  await assert.rejects(maakBunq({ apiKey: 'sleutel', statePad, fetch: vijf }).maakDraft({ rekeningId: '42', regels }),
    (f) => f instanceof DraftFout && f.zeker === false);
  assert.equal(vijf.verzoeken.length, 1, 'niet opnieuw verstuurd');

  const stuk = async () => { throw new Error('time-out'); };
  stuk.verzoeken = [];
  await assert.rejects(maakBunq({ apiKey: 'sleutel', statePad, fetch: stuk }).maakDraft({ rekeningId: '42', regels }),
    (f) => f instanceof DraftFout && f.zeker === false);

  const vier = nepFetch([{ status: 400, json: { Error: [{ error_description: 'IBAN niet toegestaan' }] } }]);
  await assert.rejects(maakBunq({ apiKey: 'sleutel', statePad, fetch: vier }).maakDraft({ rekeningId: '42', regels }),
    (f) => f instanceof DraftFout && f.zeker === true && /IBAN niet toegestaan/.test(f.message));
  assert.equal(vier.verzoeken.length, 1);
});

test('bunq.mjs: nooit een POST op payment en nooit een PUT', () => {
  const bron = readFileSync(new URL('../service/facturen/lib/bunq.mjs', import.meta.url), 'utf8')
    .split('\n').filter((r) => !r.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(bron, /'PUT'|"PUT"/);
  assert.doesNotMatch(bron, /\/payment['`]\s*,\s*\{\s*methode:\s*'POST'/);
  // Elke POST gaat naar installatie, apparaat, sessie of draft-payment.
  const posts = [...bron.matchAll(/verzoek\(([^,]+),\s*\{\s*methode:\s*'POST'/g)].map((m) => m[1].trim());
  assert.deepEqual(posts.sort(), ["'/device-server'", "'/installation'", "'/session-server'", 'pad', 'pad'].sort());
  assert.match(bron, /schrijfDraft\(draftPad\(/, 'schrijfDraft alleen met een draft-payment-pad');
  assert.equal([...bron.matchAll(/schrijfDraft\(/g)].length, 2, 'één definitie, één aanroep');
});

// -- wie mag, en welke facturen ------------------------------------------------

test('toegang: alleen met Microsoft, niet via break-glass of Basic Auth, en pas met rekening en schakelaar', () => {
  const { inst } = opzet();
  const bunq = nepBunq();
  assert.equal(toegangReden({ inst: inst(), kader: SSO, bunq }), null);
  assert.match(toegangReden({ inst: inst(), kader: { ...SSO, modus: 'breakglass' }, bunq }), /break-glass/);
  assert.match(toegangReden({ inst: inst(), kader: { ...SSO, modus: 'basic' }, bunq }), /Microsoft/);
  assert.match(toegangReden({ inst: inst(), kader: null, bunq }), /Microsoft/);
  assert.match(toegangReden({ inst: inst(), kader: SSO, bunq: null }), /niet ingesteld/);

  const uit = opzet({ aan: false });
  assert.match(toegangReden({ inst: uit.inst(), kader: SSO, bunq }), /staat uit/);

  const { opslag } = tijdelijkeOpslag();
  const geen = instellingen.bewaar(opslag, { betalen_aan: '1' });
  assert.match(geen.fouten.join(' '), /Kies eerst de rekening/, 'aanzetten zonder rekening kan niet');
  assert.match(toegangReden({ inst: instellingen.lees(opslag), kader: SSO, bunq }), /geen rekening/);
});

test('beoordelen: incasso, al betaald, ontbrekend of fout IBAN, creditnota, valuta, maximum en eigen rekening', () => {
  const { opslag, betaalOpslag, inst } = opzet({ max: '1000' });
  const reden = (velden) => {
    const f = voegFactuurToe(opslag, { message_id: crypto.randomUUID(), bedrag: 500, ...velden });
    return beoordeelFactuur(f, { inst: inst(), betaalOpslag });
  };
  assert.equal(reden({}).kan, true);
  assert.match(reden({ betaalwijze: 'incasso' }).redenen.join(), /geïncasseerd/);
  assert.match(reden({ betaalwijze: 'al_betaald' }).redenen.join(), /al betaald/);
  assert.match(reden({ iban: null }).redenen.join(), /IBAN ontbreekt/);
  assert.match(reden({ iban: 'NL91ABNA0417164301' }).redenen.join(), /controlegetal/);
  assert.match(reden({ bedrag: -50 }).redenen.join(), /creditnota/);
  assert.match(reden({ bedrag: null }).redenen.join(), /bedrag ontbreekt/);
  assert.match(reden({ bedrag: 1000.01 }).redenen.join(), /maximum/);
  assert.match(reden({ valuta: 'USD' }).redenen.join(), /euro/);
  assert.match(reden({ valuta: null }).redenen.join(), /valuta ontbreekt/);
  assert.match(reden({ leverancier: null }).redenen.join(), /leverancier ontbreekt/);

  const betaald = voegFactuurToe(opslag, { message_id: 'betaald' });
  opslag.zetBetaald(betaald.id, { betaald_op: '2026-10-01', betaald_via: 'handmatig' });
  assert.match(beoordeelFactuur(opslag.factuur(betaald.id), { inst: inst(), betaalOpslag }).redenen.join(), /al betaald/);

  instellingen.bewaar(opslag, { betalen_rekening_id: '42', betalen_rekening_iban: IBAN_C, betalen_rekening_naam: 'Zakelijk' });
  assert.match(reden({ iban: IBAN_C }).redenen.join(), /eigen rekening/);
});

// -- klaarzetten -------------------------------------------------------------

function betalerMet({ bunq = nepBunq(), klok = () => Date.parse('2026-10-14T10:00:00Z'), ...rest } = {}) {
  const o = opzet(rest);
  return { ...o, bunq, betaler: maakBetaler({ opslag: o.opslag, betaalOpslag: o.betaalOpslag, bunq, klok }) };
}

async function zetKlaar(b, ids, extra = {}) {
  const v = b.betaler.voorbereiden(ids, { inst: b.inst(), kader: SSO });
  const velden = { id: ids.map(String), ...extra };
  for (const r of v.beoordelingen) {
    if (r.iban?.status === 'nieuw') velden[`nieuw_${r.regel.factuurId}`] = '1';
  }
  return b.betaler.aanmaken({
    ids, sleutel: extra.sleutel || crypto.randomUUID(), afdruk: extra.afdruk ?? v.vingerafdruk,
    body: body(velden), inst: b.inst(), kader: extra.kader || SSO,
  });
}

test('klaarzetten: één draft met een regel per factuur, gelogd met wie het deed; geen tweede bij dubbel klikken', async () => {
  const b = betalerMet();
  const f1 = voegFactuurToe(b.opslag, { message_id: 'm1', bedrag: 1210 });
  const f2 = voegFactuurToe(b.opslag, { message_id: 'm2', leverancier: 'Van Dijk Voegmiddelen', iban: IBAN_B, bedrag: 89.95, betalingskenmerk: '1234567890123456' });

  const v = b.betaler.voorbereiden([f1.id, f2.id], { inst: b.inst(), kader: SSO });
  assert.equal(v.kan, true);
  assert.equal(v.totaal, 1299.95);

  const sleutel = crypto.randomUUID();
  const velden = body({ id: [String(f1.id), String(f2.id)], [`nieuw_${f1.id}`]: '1', [`nieuw_${f2.id}`]: '1' });
  const uit = await b.betaler.aanmaken({ ids: [f1.id, f2.id], sleutel, afdruk: v.vingerafdruk, body: velden, inst: b.inst(), kader: SSO });
  assert.equal(uit.uitkomst, 'klaar');
  assert.equal(b.bunq.aangemaakt.length, 1, 'één draft');
  assert.equal(b.bunq.aangemaakt[0].rekeningId, '42');
  assert.deepEqual(b.bunq.aangemaakt[0].regels.map((r) => [r.iban, r.bedrag, r.omschrijving]), [
    [IBAN_A, 1210, 'Factuur 2026-0123 Tegelhandel Zuid B.V.'],
    [IBAN_B, 89.95, '1234567890123456'],
  ]);
  const draft = b.betaalOpslag.draft(uit.draftId);
  assert.equal(draft.status, 'PENDING');
  assert.equal(draft.door, 'bob@voorbeeld.nl');
  const log = b.opslag.logboekVanFactuur(f1.id).find((r) => /klaargezet in bunq/.test(r.bericht));
  assert.equal(log.door, 'bob@voorbeeld.nl');
  assert.match(log.bericht, /€\s?1\.210,00.*NL91 ABNA 0417 1643 00.*draft 9100/);

  // Dezelfde sleutel nog eens: hetzelfde resultaat, geen tweede verzoek.
  const nogmaals = await b.betaler.aanmaken({ ids: [f1.id, f2.id], sleutel, afdruk: v.vingerafdruk, body: velden, inst: b.inst(), kader: SSO });
  assert.deepEqual(nogmaals, { uitkomst: 'al', draftId: uit.draftId });
  // Een nieuwe poging voor dezelfde factuur: geweigerd, er loopt er al een.
  const weer = await zetKlaar(b, [f1.id]);
  assert.equal(weer.uitkomst, 'geweigerd');
  assert.match(weer.meldingen.join(), /loopt al een conceptbetaling/);
  assert.equal(b.bunq.aangemaakt.length, 1);
});

test('twee verzoeken tegelijk voor dezelfde factuur: de database laat er maar één toe', () => {
  const { opslag, betaalOpslag } = opzet();
  const f = voegFactuurToe(opslag, {});
  const regel = { factuurId: f.id, leverancier: 'x', bedrag: 1, iban: IBAN_A, naam: 'x', omschrijving: 'x' };
  betaalOpslag.reserveer({ sleutel: 'a'.repeat(20), rekeningId: '42', regels: [regel], door: 'bob' });
  assert.throws(() => betaalOpslag.reserveer({ sleutel: 'b'.repeat(20), rekeningId: '42', regels: [regel], door: 'bob' }), DubbeleDraft);
});

test('break-glass of Basic Auth kan niet klaarzetten, ook niet met een geldig formulier', async () => {
  const b = betalerMet();
  const f = voegFactuurToe(b.opslag, {});
  for (const modus of ['breakglass', 'basic']) {
    const uit = await zetKlaar(b, [f.id], { kader: { ...SSO, modus } });
    assert.equal(uit.uitkomst, 'geweigerd', modus);
  }
  assert.equal(b.bunq.aangemaakt.length, 0);
});

test('maximum per draft geldt voor het totaal van de selectie', async () => {
  const b = betalerMet({ max: '1000' });
  const f1 = voegFactuurToe(b.opslag, { message_id: 'm1', bedrag: 600 });
  const f2 = voegFactuurToe(b.opslag, { message_id: 'm2', bedrag: 600 });
  const uit = await zetKlaar(b, [f1.id, f2.id]);
  assert.equal(uit.uitkomst, 'geweigerd');
  assert.match(uit.meldingen.join(), /hoger dan het maximum/);
  assert.equal(b.bunq.aangemaakt.length, 0);
});

test('nieuw IBAN: zonder bevestiging geen draft; gewijzigde gegevens na het tonen: opnieuw bevestigen', async () => {
  const b = betalerMet();
  const f = voegFactuurToe(b.opslag, {});
  const v = b.betaler.voorbereiden([f.id], { inst: b.inst(), kader: SSO });
  assert.equal(v.beoordelingen[0].iban.status, 'nieuw');

  const zonder = await b.betaler.aanmaken({ ids: [f.id], sleutel: crypto.randomUUID(), afdruk: v.vingerafdruk, body: body({ id: String(f.id) }), inst: b.inst(), kader: SSO });
  assert.equal(zonder.uitkomst, 'bevestigen');

  // Het bedrag verandert tussen tonen en versturen.
  b.opslag.zetUitgelezen(f.id, 'handmatig', { ...b.opslag.factuur(f.id), bedrag: 1300 });
  const gewijzigd = await zetKlaar(b, [f.id], { afdruk: v.vingerafdruk });
  assert.equal(gewijzigd.uitkomst, 'gewijzigd');
  assert.equal(b.bunq.aangemaakt.length, 0);
});

test('afwijkend IBAN: vinkje én de laatste vier tekens nodig; een IBAN wordt pas vertrouwd na goedkeuring', async () => {
  const b = betalerMet();
  const eerste = voegFactuurToe(b.opslag, { message_id: 'eerste' });
  const uit = await zetKlaar(b, [eerste.id]);
  assert.equal(uit.uitkomst, 'klaar');
  // Nog niet goedgekeurd: een volgende factuur met hetzelfde IBAN is nog steeds "nieuw".
  const tweede = voegFactuurToe(b.opslag, { message_id: 'tweede' });
  assert.equal(beoordeelFactuur(tweede, { inst: b.inst(), betaalOpslag: b.betaalOpslag }).iban.status, 'nieuw');

  // Goedgekeurd in de app -> vertrouwd.
  const bunqId = b.betaalOpslag.draft(uit.draftId).bunq_id;
  b.bunq.stand.set(bunqId, { id: bunqId, status: 'ACCEPTED', bijgewerkt: 'x', regels: [], betalingen: [] });
  await b.betaler.bijwerken();
  assert.equal(beoordeelFactuur(tweede, { inst: b.inst(), betaalOpslag: b.betaalOpslag }).iban.status, 'vertrouwd');

  // Zelfde leverancier, ander IBAN: afwijkend.
  const fraude = voegFactuurToe(b.opslag, { message_id: 'fraude', iban: IBAN_B });
  const v = b.betaler.voorbereiden([fraude.id], { inst: b.inst(), kader: SSO });
  assert.equal(v.beoordelingen[0].iban.status, 'afwijkend');
  assert.deepEqual(v.beoordelingen[0].iban.vertrouwd, [IBAN_A]);
  const poging = (velden) => b.betaler.aanmaken({
    ids: [fraude.id], sleutel: crypto.randomUUID(), afdruk: v.vingerafdruk, body: body({ id: String(fraude.id), ...velden }), inst: b.inst(), kader: SSO,
  });
  assert.equal((await poging({ [`nieuw_${fraude.id}`]: '1' })).uitkomst, 'bevestigen', 'het gewone vinkje is niet genoeg');
  assert.equal((await poging({ [`afwijkend_${fraude.id}`]: '1', [`laatste4_${fraude.id}`]: '0000' })).uitkomst, 'bevestigen', 'verkeerde laatste vier');
  assert.equal((await poging({ [`laatste4_${fraude.id}`]: IBAN_B.slice(-4) })).uitkomst, 'bevestigen', 'zonder vinkje');
  const goed = await poging({ [`afwijkend_${fraude.id}`]: '1', [`laatste4_${fraude.id}`]: IBAN_B.slice(-4).toLowerCase() });
  assert.equal(goed.uitkomst, 'klaar');
  assert.ok(b.opslag.logboekVanFactuur(fraude.id).some((r) => r.niveau === 'warn' && /Afwijkend IBAN NL20 INGB.*bekend was: NL91 ABNA/.test(r.bericht)));

  // Hetzelfde IBAN bij een andere leverancier: ook afwijkend.
  const ander = voegFactuurToe(b.opslag, { message_id: 'ander', leverancier: 'Heel Andere Leverancier', iban: IBAN_A });
  const info = beoordeelFactuur(ander, { inst: b.inst(), betaalOpslag: b.betaalOpslag }).iban;
  assert.equal(info.status, 'afwijkend');
  assert.deepEqual(info.andereLeveranciers, ['Tegelhandel Zuid B.V.']);
});

test('bunq weigert (4xx): draft mislukt, de factuur kan opnieuw', async () => {
  const b = betalerMet({ bunq: nepBunq({ maakDraft: () => { throw new DraftFout('IBAN niet toegestaan', true); } }) });
  const f = voegFactuurToe(b.opslag, {});
  const uit = await zetKlaar(b, [f.id]);
  assert.equal(uit.uitkomst, 'mislukt');
  assert.equal(b.betaalOpslag.draft(uit.draftId).status, 'mislukt');
  assert.equal(b.betaalOpslag.actieveRegel(f.id), null);
  assert.equal(beoordeelFactuur(b.opslag.factuur(f.id), { inst: b.inst(), betaalOpslag: b.betaalOpslag }).kan, true);
  assert.ok(b.opslag.logboekVanFactuur(f.id).some((r) => r.niveau === 'error' && /IBAN niet toegestaan/.test(r.bericht)));
});

test('onzeker antwoord: geen tweede draft; de sync vindt hem terug, of geeft na een half uur op', async () => {
  let tijd = Date.parse('2026-10-14T10:00:00Z');
  const bunq = nepBunq({ maakDraft: () => { throw new DraftFout('geen zeker antwoord van bunq (time-out)', false); } });
  const b = betalerMet({ bunq, klok: () => tijd });
  const f = voegFactuurToe(b.opslag, {});
  const uit = await zetKlaar(b, [f.id]);
  assert.equal(uit.uitkomst, 'onzeker');
  assert.ok(b.betaalOpslag.actieveRegel(f.id), 'de factuur blijft geblokkeerd');
  assert.equal((await zetKlaar(b, [f.id])).uitkomst, 'geweigerd');

  // Hij staat wél in bunq: de sync neemt hem over.
  bunq.lijst.set('42', [{ id: '555', status: 'PENDING', regels: [{ iban: IBAN_A, bedrag: 1210, omschrijving: 'Factuur 2026-0123 Tegelhandel Zuid B.V.' }], betalingen: [] }]);
  await b.betaler.bijwerken();
  const draft = b.betaalOpslag.draft(uit.draftId);
  assert.equal(draft.status, 'PENDING');
  assert.equal(draft.bunq_id, '555');
  bunq.stand.set('555', { id: '555', status: 'PENDING', bijgewerkt: null, regels: [], betalingen: [] });

  // Een tweede onzekere, die bunq niet heeft: na een half uur mislukt en weer vrij.
  const g = voegFactuurToe(b.opslag, { message_id: 'g', iban: IBAN_B, leverancier: 'Bouwmaat' });
  const tweede = await zetKlaar(b, [g.id]);
  assert.equal(tweede.uitkomst, 'onzeker');
  await b.betaler.bijwerken();
  assert.equal(b.betaalOpslag.draft(tweede.draftId).status, 'onzeker', 'nog niet opgegeven');
  tijd += ONZEKER_OPGEVEN_MS + 1000;
  await b.betaler.bijwerken();
  assert.equal(b.betaalOpslag.draft(tweede.draftId).status, 'mislukt');
  assert.equal(b.betaalOpslag.actieveRegel(g.id), null);
});

test('stand bijwerken: geweigerd maakt de factuur weer vrij; goedgekeurd koppelt de echte betaling', async () => {
  const b = betalerMet();
  const f = voegFactuurToe(b.opslag, { message_id: 'f' });
  const g = voegFactuurToe(b.opslag, { message_id: 'g', leverancier: 'Van Dijk', iban: IBAN_B, bedrag: 50 });
  const eerste = await zetKlaar(b, [f.id]);
  const tweede = await zetKlaar(b, [g.id]);
  const id1 = b.betaalOpslag.draft(eerste.draftId).bunq_id;
  const id2 = b.betaalOpslag.draft(tweede.draftId).bunq_id;

  b.bunq.stand.set(id1, { id: id1, status: 'REJECTED', bijgewerkt: 'x', regels: [], betalingen: [] });
  b.bunq.stand.set(id2, { id: id2, status: 'ACCEPTED', bijgewerkt: 'y', regels: [], betalingen: [{ id: '8001', iban: IBAN_B, bedrag: 50 }] });
  const r = await b.betaler.bijwerken();
  assert.equal(r.gewijzigd, 2);
  assert.equal(b.betaalOpslag.actieveRegel(f.id), null, 'geweigerd: weer vrij');
  assert.ok(b.opslag.logboekVanFactuur(f.id).some((l) => /geweigerd in de bunq-app/.test(l.bericht)));
  assert.equal(b.betaalOpslag.actieveRegel(g.id).betaling_id, '8001');

  // De betaling komt binnen bij de volgende ronde.
  assert.equal(b.betaler.koppelGoedgekeurde(), 0, 'nog niet binnen');
  voegBetalingToe(b.opslag, { id: '8001', bedrag: -50, tegenrekening_iban: IBAN_B, omschrijving: 'iets anders' });
  assert.equal(b.betaler.koppelGoedgekeurde(), 1);
  const betaald = b.opslag.factuur(g.id);
  assert.equal(betaald.status, 'betaald');
  assert.equal(betaald.bunq_betaling_id, '8001');
});

test('zelfdeRegels vergelijkt op IBAN, bedrag en omschrijving, ongeacht de volgorde', () => {
  const a = [{ iban: IBAN_A, bedrag: 1, omschrijving: 'x' }, { iban: IBAN_B, bedrag: 2, omschrijving: 'y' }];
  assert.equal(zelfdeRegels([...a].reverse(), a), true);
  assert.equal(zelfdeRegels([{ ...a[0], bedrag: 1.01 }, a[1]], a), false);
  assert.equal(zelfdeRegels([a[0]], a), false);
});

// -- schema -------------------------------------------------------------------

test('schema 6 -> 7: de nieuwe kolommen komen erbij zonder rijen te verliezen', () => {
  const { map, opslag } = tijdelijkeOpslag();
  const f = voegFactuurToe(opslag, {});
  opslag.log('info', 'oud');
  const pad = path.join(map, 'facturen.db');
  for (const [tabel, kolom] of [['facturen', 'iban_naam'], ['facturen', 'betaalwijze'], ['logboek', 'door']]) {
    opslag.db.exec(`ALTER TABLE ${tabel} DROP COLUMN ${kolom}`);
  }
  opslag.db.exec('PRAGMA user_version = 6');
  opslag.db.close();

  const db = openDatabase(pad);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSIE);
  assert.equal(SCHEMA_VERSIE, 7);
  const nieuw = maakOpslag(db);
  assert.equal(nieuw.factuur(f.id).iban, IBAN_A, 'rij nog aanwezig');
  assert.equal(nieuw.factuur(f.id).iban_naam, null);
  nieuw.zetBetaalgegevens(f.id, { iban_naam: 'Tegelhandel Zuid B.V.', betaalwijze: 'onzin' });
  assert.equal(nieuw.factuur(f.id).iban_naam, 'Tegelhandel Zuid B.V.');
  assert.equal(nieuw.factuur(f.id).betaalwijze, null, 'alleen bekende betaalwijzen');
  assert.ok(nieuw.logboek(5).some((r) => r.bericht === 'oud'));
});

// -- de schermen, via http ----------------------------------------------------

async function webOpzet({ kader = SSO, bunq = nepBunq(), aan = true } = {}) {
  const o = opzet({ aan });
  const app = maakFacturenApp({ opslag: o.opslag, bunq, pdfMap: o.pdfMap, basisPad: '/facturen', nu: () => '2026-10-14' });
  const server = http.createServer((req, res) => app.handle(req, res, { kader }));
  await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
  const adres = `http://127.0.0.1:${server.address().port}/facturen`;
  return {
    ...o, app, bunq, adres,
    stop: () => new Promise((klaar) => server.close(klaar)),
    haal: (pad) => fetch(adres + pad, { redirect: 'manual' }),
    post: (pad, velden) => fetch(adres + pad, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body(velden).toString(),
    }),
  };
}

const verborgen = (html, naam) => (html.match(new RegExp(`name="${naam}" value="([^"]*)"`)) || [])[1];

test('scherm: knop in het factuurpaneel, bevestigen, klaarzetten en daarna de stand', async () => {
  const w = await webOpzet();
  try {
    const f = voegFactuurToe(w.opslag, {});
    const paneel = await (await w.haal(`/factuur/${f.id}?deel=paneel`)).text();
    assert.match(paneel, /href="\/facturen\/betalen\/bevestig\?id=\d+">Betalen via bunq</);

    const lijst = await (await w.haal('/')).text();
    assert.match(lijst, /Meerdere betalen via bunq/);
    const selectie = await (await w.haal('/betalen')).text();
    assert.match(selectie, new RegExp(`name="id" value="${f.id}"`));

    const bevestig = await (await w.haal(`/betalen/bevestig?id=${f.id}`)).text();
    assert.match(bevestig, /NL91 ABNA 0417 1643 00/);
    assert.match(bevestig, /Nieuw IBAN/);
    assert.match(bevestig, /Van rekening.*Zakelijk/s);
    assert.match(bevestig, /Er gaat nog geen geld weg/);
    const sleutel = verborgen(bevestig, 'sleutel');
    const afdruk = verborgen(bevestig, 'afdruk');
    assert.ok(sleutel && afdruk);

    const zonder = await w.post('/betalen/bevestig', { id: String(f.id), sleutel, afdruk });
    assert.equal(zonder.status, 409);
    assert.match(await zonder.text(), /Bevestig het nieuwe IBAN/);

    const klaar = await w.post('/betalen/bevestig', { id: String(f.id), sleutel, afdruk, [`nieuw_${f.id}`]: '1' });
    assert.equal(klaar.status, 303);
    assert.match(klaar.headers.get('location'), new RegExp(`/facturen/factuur/${f.id}\\?m=draft-klaar`));
    assert.equal(w.bunq.aangemaakt.length, 1);

    const nogmaals = await w.post('/betalen/bevestig', { id: String(f.id), sleutel, afdruk, [`nieuw_${f.id}`]: '1' });
    assert.equal(nogmaals.status, 303, 'zelfde formulier nog eens: zelfde uitkomst');
    assert.equal(w.bunq.aangemaakt.length, 1, 'geen tweede draft');

    const erna = await (await w.haal(`/factuur/${f.id}?m=draft-klaar`)).text();
    assert.match(erna, /klaargezet in bunq — keur goed in de app/);
    assert.match(erna, /keur de betaling goed in de bunq-app/);
    assert.doesNotMatch(erna, />Betalen via bunq</);
    assert.match(await (await w.haal('/')).text(), /klaargezet in bunq/);
  } finally {
    await w.stop();
  }
});

test('scherm: break-glass ziet waarom niet, en een POST wordt geweigerd', async () => {
  const w = await webOpzet({ kader: { ...SSO, modus: 'breakglass' } });
  try {
    const f = voegFactuurToe(w.opslag, {});
    const pagina = await (await w.haal(`/factuur/${f.id}`)).text();
    assert.doesNotMatch(pagina, />Betalen via bunq</);
    assert.match(pagina, /niet via de noodtoegang/);
    assert.doesNotMatch(await (await w.haal('/')).text(), /Meerdere betalen/);
    const bevestig = await (await w.haal(`/betalen/bevestig?id=${f.id}`)).text();
    assert.match(bevestig, /<button class="knop" type="submit" disabled>Klaarzetten in bunq/);
    const poging = await w.post('/betalen/bevestig', {
      id: String(f.id), sleutel: verborgen(bevestig, 'sleutel'), afdruk: verborgen(bevestig, 'afdruk'), [`nieuw_${f.id}`]: '1',
    });
    assert.equal(poging.status, 403);
    assert.equal(w.bunq.aangemaakt.length, 0);
  } finally {
    await w.stop();
  }
});

test('scherm: instellingen tonen alleen bankrekeningen; aanzetten kan pas met een rekening', async () => {
  const w = await webOpzet({ aan: false });
  try {
    w.opslag.zetInstelling('betalen_rekening_id', '');
    const pagina = await (await w.haal('/instellingen')).text();
    assert.match(pagina, /<option value="42"[^>]*>Zakelijk/);
    assert.doesNotMatch(pagina, /<option value="43"/, 'geen spaarrekening');
    assert.match(pagina, /<option value="" selected>— kies een rekening —/, 'geen voorkeuze');

    const basis = { match_drempel: '0.7', terugkijken_dagen: '365', betalen_max: '5000' };
    const zonder = await w.post('/instellingen', { ...basis, betalen_aan: '1', betalen_rekening_id: '' });
    assert.equal(zonder.status, 400);
    const spaar = await w.post('/instellingen', { ...basis, betalen_rekening_id: '43' });
    assert.equal(spaar.status, 400, 'een spaarrekening kan niet');
    const goed = await w.post('/instellingen', { ...basis, betalen_aan: '1', betalen_rekening_id: '42', betalen_max: '2500' });
    assert.equal(goed.status, 303);
    const inst = instellingen.lees(w.opslag);
    assert.equal(inst.betalenAan, true);
    assert.deepEqual(inst.betalenRekening, { id: '42', iban: 'NL00BUNQ0000000042', naam: 'Zakelijk' });
    assert.equal(inst.betalenMax, 2500);
  } finally {
    await w.stop();
  }
});

test('scherm: een IBAN met een fout controlegetal wordt niet opgeslagen; tenaamstelling en betaalwijze wel', async () => {
  const w = await webOpzet();
  try {
    const f = voegFactuurToe(w.opslag, {});
    const velden = {
      leverancier: 'Tegelhandel Zuid B.V.', factuurnummer: '2026-0123', bedrag: '1210,00', valuta: 'EUR',
      iban: 'NL91 ABNA 0417 1643 01', iban_naam: 'Tegelhandel Zuid', betaalwijze: 'incasso',
    };
    const fout = await w.post(`/factuur/${f.id}/bewerken`, velden);
    assert.match(fout.headers.get('location'), /m=iban-ongeldig/);
    assert.equal(w.opslag.factuur(f.id).iban, IBAN_A, 'niets veranderd');

    const goed = await w.post(`/factuur/${f.id}/bewerken`, { ...velden, iban: 'nl20 ingb 0001 2345 67' });
    assert.match(goed.headers.get('location'), /m=bewerkt/);
    const na = w.opslag.factuur(f.id);
    assert.equal(na.iban, IBAN_B);
    assert.equal(na.iban_naam, 'Tegelhandel Zuid');
    assert.equal(na.betaalwijze, 'incasso');
    assert.ok(w.opslag.logboekVanFactuur(f.id).some((r) => r.niveau === 'warn' && /IBAN gewijzigd/.test(r.bericht) && r.door === 'bob@voorbeeld.nl'));
    assert.match(await (await w.haal(`/factuur/${f.id}`)).text(), /geïncasseerd/);
  } finally {
    await w.stop();
  }
});

// -- de sync-ronde en de CLI ----------------------------------------------------

test('sync-ronde: goedgekeurd in bunq en de betaling binnen -> in één ronde op betaald', async () => {
  const w = await webOpzet();
  try {
    const f = voegFactuurToe(w.opslag, {});
    const uit = await zetKlaar({ betaler: w.app.betaler, inst: () => instellingen.lees(w.opslag) }, [f.id]);
    assert.equal(uit.uitkomst, 'klaar');
    const bunqId = w.app.betaalOpslag.draft(uit.draftId).bunq_id;
    w.bunq.stand.set(bunqId, { id: bunqId, status: 'ACCEPTED', bijgewerkt: 'z', regels: [], betalingen: [{ id: '9901', iban: IBAN_A, bedrag: 1210 }] });
    w.bunq.betalingen = async () => [{
      id: '9901', rekening_id: '42', rekening_iban: 'NL00BUNQ0000000042', datum: '2026-10-14', bedrag: -1210, valuta: 'EUR',
      tegenrekening_iban: IBAN_A, tegenpartij_naam: 'Tegelhandel Zuid B.V.', omschrijving: 'Factuur 2026-0123 Tegelhandel Zuid B.V.',
    }];
    const r = await w.app.sync.draai({ aanleiding: 'test' });
    assert.deepEqual(r.stappen.drafts, { lopend: 1, gewijzigd: 1 });
    assert.equal(r.stappen.koppelen.betaald, 1);
    const na = w.opslag.factuur(f.id);
    assert.equal(na.status, 'betaald');
    assert.equal(na.bunq_betaling_id, '9901');
    assert.ok(w.opslag.logboekVanFactuur(f.id).some((l) => /hoort bij de goedgekeurde conceptbetaling/.test(l.bericht)));
  } finally {
    await w.stop();
  }
});

test('CLI nalezen: zonder --uitvoeren alleen tellen; zonder Claude-sleutel verandert er niets', async () => {
  const { execFile } = await import('node:child_process');
  const { opslag, map } = tijdelijkeOpslag();
  const f = voegFactuurToe(opslag, {});
  const betaald = voegFactuurToe(opslag, { message_id: 'b' });
  opslag.zetBetaald(betaald.id, { betaald_op: '2026-10-01', betaald_via: 'handmatig' });
  const draai = (args) => new Promise((klaar) => {
    execFile(process.execPath, [new URL('../service/cli/betaalgegevens-nalezen.mjs', import.meta.url).pathname, ...args], {
      env: { PATH: process.env.PATH, DATA_DIR: map, ANTHROPIC_API_KEY: '' },
    }, (fout, stdout, stderr) => klaar({ code: fout ? fout.code : 0, stdout, stderr }));
  });
  const droog = await draai([]);
  assert.equal(droog.code, 0);
  assert.match(droog.stdout, /^1 open factuur zonder tenaamstelling \(droge run/);
  assert.match(droog.stdout, new RegExp(`#${f.id} Tegelhandel`));
  const zonderSleutel = await draai(['--uitvoeren']);
  assert.equal(zonderSleutel.code, 1);
  assert.match(zonderSleutel.stderr, /Geen ANTHROPIC_API_KEY/);
  assert.equal(opslag.factuur(f.id).iban_naam, null);
});
