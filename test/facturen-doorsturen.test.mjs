// Doorsturen naar de boekhouder: de sloten die voorkomen dat er post de deur
// uit gaat die er niet uit hoort. Er gaat in deze test niets echt weg.
//   node --test test/facturen-doorsturen.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORIE_DOORGESTUURD, berichtVoorBoekhouder, magAutomatisch, stuurDoor, verwerkAchterstand,
} from '../service/facturen/lib/doorsturen.mjs';
import * as instellingen from '../service/facturen/lib/instellingen.mjs';
import { nepGraph, ruimOp, tijdelijkeOpslag, voegFactuurToe } from './facturen-hulp.mjs';

after(ruimOp);

// Instellingen zoals ze na het aanzetten van de toggle zouden staan.
function metInstellingen(opslag, waarden = {}) {
  instellingen.bewaar(opslag, {
    boekhouder_email: 'boekhouder@kantoor.nl',
    auto_doorsturen: '1',
    testmodus: '0',
    ...waarden,
  }, { nu: '2026-10-01T00:00:00Z' });
  return instellingen.lees(opslag);
}

function betaaldeFactuur(opslag, velden = {}) {
  const factuur = voegFactuurToe(opslag, velden);
  opslag.zetBetaald(factuur.id, { betaald_op: velden.betaald_op || '2026-10-05', betaald_via: 'handmatig' });
  return opslag.factuur(factuur.id);
}

test('het startmoment wordt vastgelegd zodra de toggle aangaat', () => {
  const { opslag } = tijdelijkeOpslag();
  assert.equal(instellingen.lees(opslag).autoDoorsturenSinds, '');

  instellingen.bewaar(opslag, { auto_doorsturen: '1' }, { nu: '2026-10-01T12:00:00Z' });
  assert.equal(instellingen.lees(opslag).autoDoorsturenSinds, '2026-10-01T12:00:00Z');

  // Opnieuw aanzetten terwijl hij al aanstaat verschuift het moment niet.
  instellingen.bewaar(opslag, { auto_doorsturen: '1' }, { nu: '2026-11-01T12:00:00Z' });
  assert.equal(instellingen.lees(opslag).autoDoorsturenSinds, '2026-10-01T12:00:00Z');
});

test('niets van vóór het startmoment gaat automatisch mee', () => {
  const { opslag } = tijdelijkeOpslag();
  const inst = metInstellingen(opslag);

  const oud = betaaldeFactuur(opslag, { message_id: 'm-oud', attachment_id: 'a1', betaald_op: '2026-09-15' });
  const nieuw = betaaldeFactuur(opslag, { message_id: 'm-nieuw', attachment_id: 'a2', betaald_op: '2026-10-05' });

  const oudeUitkomst = magAutomatisch(oud, inst);
  assert.equal(oudeUitkomst.mag, false);
  assert.match(oudeUitkomst.reden, /vóór het aanzetten/);
  assert.equal(magAutomatisch(nieuw, inst).mag, true);
});

test('automatisch doorsturen kan niet zonder toggle, betaling of betaaldatum', () => {
  const { opslag } = tijdelijkeOpslag();
  const uit = metInstellingen(opslag, { auto_doorsturen: '0' });
  const factuur = betaaldeFactuur(opslag);
  assert.equal(magAutomatisch(factuur, uit).mag, false);

  const aan = metInstellingen(opslag, { auto_doorsturen: '1' });
  assert.equal(magAutomatisch({ ...factuur, status: 'open' }, aan).mag, false, 'nog niet betaald');
  assert.equal(magAutomatisch({ ...factuur, betaald_op: null }, aan).mag, false, 'geen betaaldatum');
  assert.equal(magAutomatisch({ ...factuur, doorgestuurd_op: '2026-10-06T10:00:00Z' }, aan).mag, false, 'al doorgestuurd');
});

test('zonder boekhouderadres gaat er niets weg, ook niet met de knop', async () => {
  const { opslag } = tijdelijkeOpslag();
  const inst = metInstellingen(opslag, { boekhouder_email: '' });
  const graph = nepGraph();
  const factuur = betaaldeFactuur(opslag);

  const uitkomst = await stuurDoor(opslag, graph, factuur, { inst, handmatig: true });
  assert.equal(uitkomst.verstuurd, false);
  assert.match(uitkomst.reden, /geen boekhouderadres/);
  assert.equal(graph.verstuurd.length, 0);
  assert.equal(opslag.factuur(factuur.id).doorgestuurd_op, null);

  const laatste = opslag.logboekVanFactuur(factuur.id, 5)[0];
  assert.match(laatste.bericht, /geen e-mailadres van de boekhouder/);
  assert.equal(laatste.niveau, 'warn');
});

test('testmodus logt alleen en verstuurt niets', async () => {
  const { opslag } = tijdelijkeOpslag();
  const inst = metInstellingen(opslag, { testmodus: '1' });
  const graph = nepGraph();
  const factuur = betaaldeFactuur(opslag);

  const uitkomst = await stuurDoor(opslag, graph, factuur, { inst, handmatig: false });
  assert.equal(uitkomst.verstuurd, false);
  assert.equal(uitkomst.testmodus, true);
  assert.equal(graph.verstuurd.length, 0);
  assert.equal(opslag.factuur(factuur.id).doorgestuurd_op, null);
  assert.match(opslag.logboekVanFactuur(factuur.id, 5)[0].bericht,
    /TESTMODUS: zou doorsturen naar boekhouder@kantoor\.nl/);
});

test('de knop verstuurt altijd echt, ook in testmodus en ook opnieuw', async () => {
  const { opslag } = tijdelijkeOpslag();
  const inst = metInstellingen(opslag, { testmodus: '1' });
  const graph = nepGraph();
  const factuur = betaaldeFactuur(opslag);

  const eerste = await stuurDoor(opslag, graph, factuur, { inst, handmatig: true });
  assert.equal(eerste.verstuurd, true);
  assert.equal(graph.verstuurd.length, 1);
  assert.equal(graph.verstuurd[0].messageId, factuur.message_id);
  assert.deepEqual(graph.verstuurd[0].naar, ['boekhouder@kantoor.nl']);

  const opnieuw = await stuurDoor(opslag, graph, opslag.factuur(factuur.id), { inst, handmatig: true });
  assert.equal(opnieuw.verstuurd, true);
  assert.equal(graph.verstuurd.length, 2, 'nog een keer sturen mag met de knop');
});

test('de begeleidende tekst staat boven de kerngegevens', () => {
  const { opslag } = tijdelijkeOpslag();
  const inst = metInstellingen(opslag, { doorstuur_tekst: 'Hoi, hierbij een betaalde factuur.' });
  const factuur = betaaldeFactuur(opslag);

  const bericht = berichtVoorBoekhouder(factuur, inst);
  assert.match(bericht, /^Hoi, hierbij een betaalde factuur\./);
  assert.match(bericht, /Leverancier: Tegelhandel Zuid B\.V\./);
  assert.match(bericht, /Factuurnummer: 2026-0123/);
  assert.match(bericht, /Betaald op: 5 okt 2026/);

  // Zonder tekst van Bob blijven alleen de feiten staan.
  const zonder = berichtVoorBoekhouder(factuur, { ...inst, doorstuurTekst: '' });
  assert.match(zonder, /^Leverancier:/);
});

test('een mail met meerdere PDFs gaat één keer de deur uit', async () => {
  const { opslag } = tijdelijkeOpslag();
  const inst = metInstellingen(opslag);
  const graph = nepGraph();

  const een = betaaldeFactuur(opslag, { message_id: 'zelfde-mail', attachment_id: 'bijlage-1' });
  const twee = betaaldeFactuur(opslag, { message_id: 'zelfde-mail', attachment_id: 'bijlage-2' });

  const uit = await verwerkAchterstand(opslag, graph, inst);
  assert.equal(graph.verstuurd.length, 1, 'de mail zelf gaat één keer');
  assert.equal(uit.verstuurd, 1);

  // Beide regels staan als doorgestuurd, want de boekhouder heeft ze gekregen.
  assert.ok(opslag.factuur(een.id).doorgestuurd_op);
  assert.ok(opslag.factuur(twee.id).doorgestuurd_op);

  // Welke van de twee de mail "trok" ligt aan de volgorde van de lijst; de
  // andere moet als meegestuurd gelogd zijn.
  const berichten = [een, twee].map((f) => opslag.logboekVanFactuur(f.id, 5)[0].bericht);
  assert.equal(berichten.filter((b) => /^Doorgestuurd naar/.test(b)).length, 1);
  assert.equal(berichten.filter((b) => /Meegestuurd in de doorgestuurde mail/.test(b)).length, 1);
  assert.equal(opslag.lijst('doorsturen', '', '2026-10-06').length, 0, 'geen achterstand meer');
});

test('nooit twee keer dezelfde factuur automatisch', async () => {
  const { opslag } = tijdelijkeOpslag();
  const inst = metInstellingen(opslag);
  const graph = nepGraph();
  betaaldeFactuur(opslag);

  await verwerkAchterstand(opslag, graph, inst);
  await verwerkAchterstand(opslag, graph, inst);
  assert.equal(graph.verstuurd.length, 1);
});

test('de categorie in Outlook wordt alleen gezet als dat aanstaat', async () => {
  const { opslag } = tijdelijkeOpslag();
  const graph = nepGraph();

  const zonder = metInstellingen(opslag, { outlook_categorie: '0' });
  const een = betaaldeFactuur(opslag, { message_id: 'm1', attachment_id: 'a1' });
  await stuurDoor(opslag, graph, een, { inst: zonder, handmatig: true });
  assert.equal(graph.categorieen.length, 0);

  const met = metInstellingen(opslag, { outlook_categorie: '1' });
  const twee = betaaldeFactuur(opslag, { message_id: 'm2', attachment_id: 'a2' });
  await stuurDoor(opslag, graph, twee, { inst: met, handmatig: true });
  assert.deepEqual(graph.categorieen, [{ messageId: 'm2', categorie: CATEGORIE_DOORGESTUURD }]);
});

test('een mislukte Graph-aanroep laat de factuur niet als doorgestuurd achter', async () => {
  const { opslag } = tijdelijkeOpslag();
  const inst = metInstellingen(opslag);
  const graph = nepGraph({ faalt: true });
  const factuur = betaaldeFactuur(opslag);

  await assert.rejects(() => stuurDoor(opslag, graph, factuur, { inst, handmatig: true }), /Graph is stuk/);
  assert.equal(opslag.factuur(factuur.id).doorgestuurd_op, null);

  // In een ronde wordt de fout afgevangen en gelogd.
  const uit = await verwerkAchterstand(opslag, graph, inst);
  assert.equal(uit.verstuurd, 0);
  assert.match(opslag.logboekVanFactuur(factuur.id, 5)[0].bericht, /Doorsturen mislukt/);
});

test('zonder Microsoft 365 wordt de stap overgeslagen in plaats van te vallen', async () => {
  const { opslag } = tijdelijkeOpslag();
  const inst = metInstellingen(opslag);
  const factuur = betaaldeFactuur(opslag);

  const uitkomst = await stuurDoor(opslag, nepGraph({ beschikbaar: false }), factuur, { inst, handmatig: true });
  assert.equal(uitkomst.verstuurd, false);
  assert.match(uitkomst.reden, /Microsoft 365/);
  assert.equal(opslag.factuur(factuur.id).doorgestuurd_op, null);
});

test('instellingen worden gevalideerd en elke wijziging komt in het logboek', () => {
  const { opslag } = tijdelijkeOpslag();

  const fout = instellingen.bewaar(opslag, { boekhouder_email: 'geen adres' });
  assert.equal(fout.fouten.length, 1);
  assert.match(fout.fouten[0], /Geen geldig e-mailadres/);
  assert.equal(instellingen.lees(opslag).ruw.boekhouder_email, '', 'bij een fout wordt niets opgeslagen');

  assert.match(instellingen.bewaar(opslag, { match_drempel: '0.2' }).fouten[0], /Matchdrempel/);
  assert.match(instellingen.bewaar(opslag, { terugkijken_dagen: '0' }).fouten[0], /Terugkijkperiode/);

  const goed = instellingen.bewaar(opslag, { boekhouder_email: ' een@kantoor.nl , twee@kantoor.nl ', match_drempel: '0,85' });
  assert.deepEqual(goed.fouten, []);
  const inst = instellingen.lees(opslag);
  assert.deepEqual(inst.boekhouderEmails, ['een@kantoor.nl', 'twee@kantoor.nl']);
  assert.equal(inst.matchDrempel, 0.85, 'een komma mag ook');

  const regels = opslag.logboek(10).map((r) => r.bericht);
  assert.ok(regels.some((r) => /Instelling boekhouder_email: "" -> "een@kantoor\.nl, twee@kantoor\.nl"/.test(r)));
  assert.ok(regels.some((r) => /Instelling match_drempel: "0\.7" -> "0\.85"/.test(r)));
});

test('standaard staat testmodus aan en automatisch doorsturen uit', () => {
  const { opslag } = tijdelijkeOpslag();
  const inst = instellingen.lees(opslag);
  assert.equal(inst.testmodus, true, 'testmodus standaard aan');
  assert.equal(inst.autoDoorsturen, false);
  assert.deepEqual(inst.boekhouderEmails, [], 'geen verzonnen adres');
  assert.equal(inst.doorstuurTekst, '', 'geen verzonnen tekst');
  assert.equal(inst.matchDrempel, 0.7);
  assert.equal(inst.terugkijkenDagen, 365);
});
