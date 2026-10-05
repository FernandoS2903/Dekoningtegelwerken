// Koppelen van betalingen aan facturen: de scoreregels, het greedy
// toewijzen en wat de drempel met een ronde doet.
//   node --test test/facturen-koppelen.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { koppel, score, verwerk } from '../service/facturen/lib/koppelen.mjs';
import { gelijkenis, normaliseerNaam } from '../service/facturen/lib/hulp.mjs';
import { ruimOp, tijdelijkeOpslag, voegBetalingToe, voegFactuurToe } from './facturen-hulp.mjs';

after(ruimOp);

const factuur = (velden = {}) => ({
  id: 1,
  bedrag: 1210,
  factuurdatum: '2026-10-01',
  ontvangen: '2026-10-01T09:00:00Z',
  leverancier: 'Tegelhandel Zuid B.V.',
  factuurnummer: '2026-0123',
  betalingskenmerk: null,
  iban: 'NL91ABNA0417164300',
  ...velden,
});

const betaling = (velden = {}) => ({
  id: '501',
  datum: '2026-10-05',
  bedrag: -1210,
  tegenrekening_iban: 'NL91ABNA0417164300',
  tegenpartij_naam: 'Tegelhandel Zuid B.V.',
  omschrijving: 'Betaling factuur 2026-0123',
  ...velden,
});

test('een exact gelijk bedrag is verplicht', () => {
  assert.equal(score(factuur(), betaling({ bedrag: -1210 })).score > 0, true);
  assert.equal(score(factuur(), betaling({ bedrag: -1209 })).score, 0, 'een euro verschil is geen match');
  assert.equal(score(factuur(), betaling({ bedrag: -1210.005 })).score > 0, true, 'binnen een cent mag');
  assert.equal(score(factuur({ bedrag: null }), betaling()).score, 0, 'zonder bedrag geen match');
});

test('alleen uitgaande betalingen tellen mee', () => {
  assert.equal(score(factuur(), betaling({ bedrag: 1210 })).score, 0, 'een bijschrijving is geen betaling');
  assert.equal(score(factuur({ bedrag: -1210 }), betaling({ bedrag: -1210 })).score, 0,
    'een creditnota wordt niet aan een uitgaande betaling gehangen');
});

test('een betaling van meer dan zeven dagen vóór de factuurdatum valt af', () => {
  assert.equal(score(factuur(), betaling({ datum: '2026-09-28' })).score > 0, true, 'drie dagen ervoor mag');
  assert.equal(score(factuur(), betaling({ datum: '2026-09-24' })).score > 0, true, 'zeven dagen ervoor mag');
  assert.equal(score(factuur(), betaling({ datum: '2026-09-20' })).score, 0, 'elf dagen ervoor niet');
});

test('zonder factuurdatum geldt de ontvangstdatum als ijkpunt', () => {
  const zonderDatum = factuur({ factuurdatum: null, ontvangen: '2026-10-01T09:00:00Z' });
  assert.equal(score(zonderDatum, betaling({ datum: '2026-09-20' })).score, 0);
  assert.equal(score(zonderDatum, betaling({ datum: '2026-10-02' })).score > 0, true);
});

test('de losse onderdelen tellen op zoals afgesproken', () => {
  const alleenBedrag = score(
    factuur({ iban: null, factuurnummer: null, leverancier: 'Heel Iets Anders' }),
    betaling({ tegenrekening_iban: null, omschrijving: 'maandelijkse afschrijving', tegenpartij_naam: 'Zomaar Iemand' }),
  );
  assert.equal(alleenBedrag.score, 0.4, 'alleen het bedrag');

  const metIban = score(
    factuur({ factuurnummer: null, leverancier: 'Heel Iets Anders' }),
    betaling({ omschrijving: 'afschrijving', tegenpartij_naam: 'Zomaar Iemand' }),
  );
  assert.equal(metIban.score, 0.8, 'bedrag plus IBAN');

  const metKenmerk = score(
    factuur({ iban: null, leverancier: 'Heel Iets Anders' }),
    betaling({ tegenrekening_iban: null, tegenpartij_naam: 'Zomaar Iemand' }),
  );
  assert.equal(metKenmerk.score, 0.7, 'bedrag plus kenmerk uit de omschrijving');

  const metNaam = score(
    factuur({ iban: null, factuurnummer: null }),
    betaling({ tegenrekening_iban: null, omschrijving: 'afschrijving' }),
  );
  assert.equal(metNaam.score, 0.6, 'bedrag plus naam');

  const alles = score(factuur(), betaling());
  assert.equal(alles.score, 1, 'nooit boven 1,0');
  assert.deepEqual(alles.redenen, [
    'bedrag klopt exact', 'IBAN van de leverancier klopt',
    'kenmerk staat in de omschrijving', 'naam lijkt op de tegenpartij',
  ]);
});

test('een kenmerk wordt ook gevonden als de notatie verschilt', () => {
  const metStreepje = score(
    factuur({ iban: null, leverancier: 'X' }),
    betaling({ tegenrekening_iban: null, tegenpartij_naam: 'Y', omschrijving: 'FACT 20260123 spoed' }),
  );
  assert.equal(metStreepje.score, 0.7, '2026-0123 komt overeen met 20260123');

  const teKort = score(
    factuur({ iban: null, leverancier: 'X', factuurnummer: '12' }),
    betaling({ tegenrekening_iban: null, tegenpartij_naam: 'Y', omschrijving: 'bedrag 12' }),
  );
  assert.equal(teKort.score, 0.4, 'een kenmerk van minder dan vier tekens telt niet');
});

test('de rechtsvorm telt niet mee bij het vergelijken van namen', () => {
  assert.equal(normaliseerNaam('Tegelhandel Zuid B.V.'), 'tegelhandelzuid');
  assert.equal(normaliseerNaam('Van Dijk Holding N.V.'), 'vandijk');
  assert.equal(gelijkenis('Tegelhandel Zuid B.V.', 'Tegelhandel Zuid'), 1);
  assert.ok(gelijkenis('Bouwmaat Velsen', 'Bouwmaat Velzen') >= 0.75, 'een tikfout mag');
  assert.ok(gelijkenis('Jansen Tegels', 'Praxis') < 0.75);
});

test('greedy: de beste combinatie eerst, elke factuur en betaling één keer', () => {
  const facturen = [
    factuur({ id: 1, bedrag: 100, factuurnummer: 'AAA111', iban: null, leverancier: 'Een' }),
    factuur({ id: 2, bedrag: 100, factuurnummer: 'BBB222', iban: null, leverancier: 'Twee' }),
  ];
  const betalingen = [
    betaling({ id: 'p1', bedrag: -100, tegenrekening_iban: null, tegenpartij_naam: 'Twee', omschrijving: 'ref BBB222' }),
    betaling({ id: 'p2', bedrag: -100, tegenrekening_iban: null, tegenpartij_naam: 'onbekend', omschrijving: 'geen ref' }),
  ];

  const paren = koppel(facturen, betalingen);
  assert.equal(paren.length, 2);
  assert.deepEqual(paren[0], { ...paren[0], factuurId: 2, betalingId: 'p1' });
  assert.ok(paren[0].score > paren[1].score, 'de sterkste match staat vooraan');
  assert.deepEqual(paren[1], { ...paren[1], factuurId: 1, betalingId: 'p2' });

  assert.equal(new Set(paren.map((p) => p.factuurId)).size, 2);
  assert.equal(new Set(paren.map((p) => p.betalingId)).size, 2);
});

test('bij gelijke score wint de betaling die het dichtst bij de factuurdatum ligt', () => {
  const facturen = [factuur({ id: 7, bedrag: 50, iban: null, factuurnummer: null, leverancier: 'X' })];
  const betalingen = [
    betaling({ id: 'ver', bedrag: -50, datum: '2026-10-20', tegenrekening_iban: null, tegenpartij_naam: 'Y', omschrijving: '' }),
    betaling({ id: 'dichtbij', bedrag: -50, datum: '2026-10-02', tegenrekening_iban: null, tegenpartij_naam: 'Y', omschrijving: '' }),
  ];
  const paren = koppel(facturen, betalingen);
  assert.equal(paren.length, 1);
  assert.equal(paren[0].betalingId, 'dichtbij');
});

test('een ronde: boven de drempel betaald, eronder een suggestie', () => {
  const { opslag } = tijdelijkeOpslag();
  const zeker = voegFactuurToe(opslag, { message_id: 'm-zeker', attachment_id: 'a1' });
  const twijfel = voegFactuurToe(opslag, {
    message_id: 'm-twijfel', attachment_id: 'a2',
    factuurnummer: 'ZZZ999', bedrag: 300, iban: null, leverancier: 'Onbekende Groothandel',
  });
  voegBetalingToe(opslag, { id: 'p-zeker' });
  voegBetalingToe(opslag, {
    id: 'p-twijfel', bedrag: -300, tegenrekening_iban: null,
    tegenpartij_naam: 'Iets Heel Anders', omschrijving: 'geen kenmerk',
  });

  const uit = verwerk(opslag, 0.7);
  assert.equal(uit.betaald, 1);
  assert.equal(uit.suggesties, 1);

  const naZeker = opslag.factuur(zeker.id);
  assert.equal(naZeker.status, 'betaald');
  assert.equal(naZeker.betaald_via, 'bunq');
  assert.equal(naZeker.betaald_op, '2026-10-05', 'de datum van de betaling, niet van vandaag');
  assert.equal(naZeker.bunq_betaling_id, 'p-zeker');
  assert.equal(opslag.betaling('p-zeker').gekoppelde_factuur_id, zeker.id);

  const naTwijfel = opslag.factuur(twijfel.id);
  assert.equal(naTwijfel.status, 'open', 'onder de drempel blijft open');
  assert.equal(naTwijfel.suggestie_betaling_id, 'p-twijfel');
  assert.equal(naTwijfel.suggestie_score, 0.4);
  assert.equal(opslag.betaling('p-twijfel').gekoppelde_factuur_id, null);
});

test('suggesties worden elke ronde opnieuw berekend', () => {
  const { opslag } = tijdelijkeOpslag();
  const f = voegFactuurToe(opslag, { bedrag: 300, iban: null, factuurnummer: 'ZZZ999', leverancier: 'Groothandel' });
  voegBetalingToe(opslag, { id: 'p1', bedrag: -300, tegenrekening_iban: null, tegenpartij_naam: 'Anders', omschrijving: '' });

  verwerk(opslag, 0.9);
  assert.equal(opslag.factuur(f.id).suggestie_betaling_id, 'p1');

  // Betaling verdwijnt uit de periode: de suggestie hoort weg te zijn.
  opslag.db.prepare('DELETE FROM bunq_betalingen WHERE id = ?').run('p1');
  verwerk(opslag, 0.9);
  assert.equal(opslag.factuur(f.id).suggestie_betaling_id, null);
});

test('een al gekoppelde betaling wordt niet nog eens gebruikt', () => {
  const { opslag } = tijdelijkeOpslag();
  voegFactuurToe(opslag, { message_id: 'm1', attachment_id: 'a1' });
  voegBetalingToe(opslag, { id: 'p1' });
  verwerk(opslag, 0.7);

  const tweede = voegFactuurToe(opslag, { message_id: 'm2', attachment_id: 'a2' });
  const uit = verwerk(opslag, 0.7);
  assert.equal(uit.betaald, 0, 'er is geen vrije betaling meer');
  assert.equal(opslag.factuur(tweede.id).status, 'open');
});

test('facturen die nog niet uitgelezen zijn doen niet mee', () => {
  const { opslag } = tijdelijkeOpslag();
  const { id } = opslag.voegFactuurToe({ message_id: 'm-pending', attachment_id: '' });
  voegBetalingToe(opslag, { id: 'p1' });
  const uit = verwerk(opslag, 0.7);
  assert.equal(uit.bekeken, 0);
  assert.equal(opslag.factuur(id).status, 'open');
});
