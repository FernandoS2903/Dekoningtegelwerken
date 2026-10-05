// De hele sync-ronde met nagebootste koppelingen: mail -> uitlezen -> bunq ->
// koppelen -> achterstand doorsturen, en wat er gebeurt als een stap faalt.
//   node --test test/facturen-sync.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

import { maakSync, vatSamen } from '../service/facturen/lib/sync.mjs';
import * as instellingen from '../service/facturen/lib/instellingen.mjs';
import { nepGraph, ruimOp, tijdelijkeOpslag } from './facturen-hulp.mjs';

after(ruimOp);

const MAILS = [
  {
    id: 'mail-pdf',
    subject: 'Factuur 2026-0123',
    from: { emailAddress: { name: 'Tegelhandel Zuid', address: 'facturen@tegelhandelzuid.nl' } },
    receivedDateTime: '2026-10-01T09:00:00Z',
    hasAttachments: true,
  },
  {
    id: 'mail-tekst',
    subject: 'Nieuwsbrief oktober',
    from: { emailAddress: { name: 'Vakblad', address: 'redactie@vakblad.nl' } },
    receivedDateTime: '2026-10-02T09:00:00Z',
    hasAttachments: false,
  },
];

const BIJLAGEN = {
  'mail-pdf': [{
    id: 'bijlage-1',
    name: 'Factuur 2026-0123.pdf',
    contentBytes: Buffer.from('%PDF-1.7 nep').toString('base64'),
  }],
};

// Claude zegt: de PDF is een factuur, de nieuwsbrief niet.
function nepClaude() {
  const gelezen = [];
  return {
    beschikbaar: true,
    model: 'nep-model',
    gelezen,
    async leesFactuur({ pdf, tekst, onderwerp }) {
      gelezen.push({ metPdf: Boolean(pdf), onderwerp });
      if (!pdf) return { isFactuur: false, velden: leegVeld() };
      return {
        isFactuur: true,
        velden: {
          leverancier: 'Tegelhandel Zuid B.V.',
          factuurnummer: '2026-0123',
          factuurdatum: '2026-10-01',
          vervaldatum: '2026-10-31',
          bedrag: 1210,
          valuta: 'EUR',
          iban: 'NL91ABNA0417164300',
          betalingskenmerk: null,
          omschrijving: 'XXL tegels',
        },
      };
    },
  };
}

const leegVeld = () => ({
  leverancier: null, factuurnummer: null, factuurdatum: null, vervaldatum: null,
  bedrag: null, valuta: null, iban: null, betalingskenmerk: null, omschrijving: null,
});

function nepBunq(betalingen = []) {
  return { beschikbaar: true, async betalingen() { return betalingen; } };
}

const DE_BETALING = {
  id: '9001',
  rekening_id: '1',
  rekening_iban: 'NL00BUNQ0000000001',
  datum: '2026-10-05',
  bedrag: -1210,
  valuta: 'EUR',
  tegenrekening_iban: 'NL91ABNA0417164300',
  tegenpartij_naam: 'Tegelhandel Zuid B.V.',
  omschrijving: 'Factuur 2026-0123',
};

function bouw({ graphOpties = {}, bunqBetalingen = [DE_BETALING], instelWaarden = {} } = {}) {
  const { opslag, pdfMap } = tijdelijkeOpslag();
  mkdirSync(pdfMap, { recursive: true });
  instellingen.bewaar(opslag, {
    boekhouder_email: 'boekhouder@kantoor.nl',
    testmodus: '1',
    ...instelWaarden,
  }, { nu: '2026-09-01T00:00:00Z' });

  const graph = nepGraph({ mails: MAILS, bijlagen: BIJLAGEN, tekst: { 'mail-tekst': 'Lees onze nieuwsbrief' }, ...graphOpties });
  const claude = nepClaude();
  const sync = maakSync({
    opslag, graph, claude, bunq: nepBunq(bunqBetalingen), pdfMap,
    instellingenLezer: () => instellingen.lees(opslag),
  });
  return { opslag, graph, claude, sync, pdfMap };
}

test('een volledige ronde leest de mail, laat uitlezen, koppelt en stuurt niets weg in testmodus', async () => {
  const { opslag, graph, claude, sync } = bouw();

  const uit = await sync.draai({ aanleiding: 'test' });

  assert.equal(uit.stappen.mail.mails, 2);
  assert.equal(uit.stappen.mail.nieuw, 2);
  assert.equal(uit.stappen.mail.zonderPdf, 1);

  assert.equal(uit.stappen.uitlezen.gelukt, 1);
  assert.equal(uit.stappen.uitlezen.geenFactuur, 1);
  assert.equal(uit.stappen.uitlezen.mislukt, 0);
  assert.deepEqual(claude.gelezen.map((g) => g.metPdf), [true, false]);

  assert.equal(uit.stappen.bunq.opgehaald, 1);
  assert.equal(uit.stappen.koppelen.betaald, 1, 'bedrag, IBAN, kenmerk en naam kloppen allemaal');
  assert.equal(uit.stappen.koppelen.suggesties, 0);

  // Testmodus: gelogd, niets verstuurd.
  assert.equal(uit.stappen.doorsturen.getest, 0, 'automatisch doorsturen staat uit, dus ook geen testregel');
  assert.equal(graph.verstuurd.length, 0);

  const facturen = opslag.lijst('alle', '', '2026-10-06');
  assert.equal(facturen.length, 2);
  const factuur = facturen.find((f) => f.message_id === 'mail-pdf');
  assert.equal(factuur.status, 'betaald');
  assert.equal(factuur.betaald_via, 'bunq');
  assert.equal(factuur.betaald_op, '2026-10-05');
  assert.equal(factuur.bijlage_naam, 'Factuur 2026-0123.pdf');
  assert.match(factuur.pdf_pad, /^[0-9a-f-]{36}-Factuur_2026-0123\.pdf$/, 'uuid plus veilige bestandsnaam');
  assert.ok(!factuur.pdf_pad.includes('/'), 'alleen de bestandsnaam staat in de database');

  const nieuwsbrief = facturen.find((f) => f.message_id === 'mail-tekst');
  assert.equal(nieuwsbrief.status, 'genegeerd');
  assert.equal(nieuwsbrief.uitlees_status, 'geen_factuur');
  assert.equal(nieuwsbrief.mail_tekst, 'Lees onze nieuwsbrief');
});

test('met de toggle aan gaat alleen wat ná het startmoment betaald is, en in testmodus alleen naar het logboek', async () => {
  const { opslag, graph, sync } = bouw({
    instelWaarden: { auto_doorsturen: '1', testmodus: '1' },
  });

  const uit = await sync.draai();
  assert.equal(uit.stappen.doorsturen.getest, 1, 'één factuur zou zijn doorgestuurd');
  assert.equal(graph.verstuurd.length, 0, 'maar er ging niets weg');
  assert.ok(opslag.logboek(30).some((r) => /TESTMODUS: zou doorsturen naar boekhouder@kantoor\.nl/.test(r.bericht)));
});

test('met de toggle aan en testmodus uit gaat de factuur echt door', async () => {
  const { opslag, graph, sync } = bouw({
    instelWaarden: { auto_doorsturen: '1', testmodus: '0' },
  });

  const uit = await sync.draai();
  assert.equal(uit.stappen.doorsturen.verstuurd, 1);
  assert.equal(graph.verstuurd.length, 1);
  assert.equal(graph.verstuurd[0].messageId, 'mail-pdf');
  assert.match(graph.verstuurd[0].commentaar, /Factuurnummer: 2026-0123/);

  const factuur = opslag.lijst('alle', '', '2026-10-06').find((f) => f.message_id === 'mail-pdf');
  assert.ok(factuur.doorgestuurd_op);
  assert.equal(factuur.doorgestuurd_naar, 'boekhouder@kantoor.nl');
});

test('een tweede ronde doet niets dubbel', async () => {
  const { opslag, graph, sync } = bouw({ instelWaarden: { auto_doorsturen: '1', testmodus: '0' } });
  await sync.draai();
  const naEerste = opslag.lijst('alle', '', '2026-10-06').length;

  await sync.draai();
  assert.equal(opslag.lijst('alle', '', '2026-10-06').length, naEerste, 'geen dubbele facturen');
  assert.equal(graph.verstuurd.length, 1, 'niet twee keer doorgestuurd');
});

test('een mislukte stap stopt de rest van de ronde niet', async () => {
  const { opslag, sync } = bouw();
  // Laat het uitlezen struikelen door Claude te laten vallen.
  const kapotteClaude = {
    beschikbaar: true,
    model: 'nep',
    async leesFactuur() { throw new Error('model onbereikbaar'); },
  };
  const eigen = maakSync({
    opslag,
    graph: nepGraph({ mails: MAILS, bijlagen: BIJLAGEN, tekst: {} }),
    claude: kapotteClaude,
    bunq: nepBunq([DE_BETALING]),
    pdfMap: bouw().pdfMap,
    instellingenLezer: () => instellingen.lees(opslag),
  });

  const uit = await eigen.draai();
  assert.equal(uit.stappen.uitlezen.mislukt, 2, 'beide mails mislukken');
  assert.equal(uit.stappen.bunq.opgehaald, 1, 'bunq loopt gewoon door');
  assert.ok(uit.klaar, 'de ronde is netjes afgerond');

  const mislukt = opslag.lijst('controle', '', '2026-10-06');
  assert.equal(mislukt.length, 2);
  assert.equal(mislukt[0].uitlees_status, 'mislukt');
  assert.match(mislukt[0].uitlees_fout, /model onbereikbaar/);
});

test('ontbrekende koppelingen slaan hun stap over in plaats van te vallen', async () => {
  const { opslag, pdfMap } = tijdelijkeOpslag();
  mkdirSync(pdfMap, { recursive: true });
  const sync = maakSync({
    opslag,
    graph: { beschikbaar: false },
    claude: { beschikbaar: false },
    bunq: { beschikbaar: false },
    pdfMap,
    instellingenLezer: () => instellingen.lees(opslag),
  });

  const uit = await sync.draai();
  assert.match(uit.stappen.mail.overgeslagen, /Microsoft 365/);
  assert.match(uit.stappen.uitlezen.overgeslagen, /Claude/);
  assert.match(uit.stappen.bunq.overgeslagen, /bunq/);
  assert.equal(uit.stappen.koppelen.betaald, 0);
  assert.ok(uit.klaar);
});

test('er draait nooit meer dan één ronde tegelijk', async () => {
  const { sync } = bouw();
  const eerste = sync.draai();
  const tweede = await sync.draai();
  assert.deepEqual(tweede, { bezig: true });
  await eerste;
  assert.equal(sync.bezig(), false);
});

test('het resultaat van de laatste ronde wordt bewaard en samengevat', async () => {
  const { opslag, sync } = bouw();
  await sync.draai();

  const inst = instellingen.lees(opslag);
  assert.ok(inst.laatsteSync, 'het tijdstip staat opgeslagen');

  const samenvatting = vatSamen(inst.laatsteSyncResultaat);
  assert.match(samenvatting, /2 nieuw/);
  assert.match(samenvatting, /1 uitgelezen/);
  assert.match(samenvatting, /1 betalingen/);
  assert.match(samenvatting, /1 gekoppeld/);

  assert.equal(vatSamen(''), '');
  assert.equal(vatSamen('geen json'), '');
});
