// Uitlezen met de Claude API: het parsen van antwoorden en de aanroep zelf,
// met een nagebootste fetch. Er gaat geen verzoek naar buiten.
//   node --test test/facturen-uitlezen.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_URL, API_VERSIE, eersteJsonObject, maakClaude, parseerAntwoord, tekstUitAntwoord,
} from '../service/facturen/lib/claude.mjs';
import { naarBedrag, naarDatum, naarIban, veiligeBestandsnaam } from '../service/facturen/lib/hulp.mjs';
import { nepFetch, ruimOp } from './facturen-hulp.mjs';

after(ruimOp);

const antwoordMet = (tekst) => ({ json: { content: [{ type: 'text', text: tekst }], stop_reason: 'end_turn' } });

test('bedragnotaties worden goed omgezet', () => {
  assert.equal(naarBedrag('1.234,56'), 1234.56, 'Nederlandse notatie');
  assert.equal(naarBedrag('1,234.56'), 1234.56, 'Engelse notatie');
  assert.equal(naarBedrag('1234.56'), 1234.56);
  assert.equal(naarBedrag('1234,56'), 1234.56);
  assert.equal(naarBedrag('5.000'), 5000, 'punt als duizendscheiding');
  assert.equal(naarBedrag('1.500,00'), 1500);
  assert.equal(naarBedrag('90'), 90);
  assert.equal(naarBedrag('€ 90,-'), 90);
  assert.equal(naarBedrag('EUR 1.210,00'), 1210);
  assert.equal(naarBedrag(1210), 1210, 'een getal blijft een getal');
  assert.equal(naarBedrag('-45,00'), -45, 'creditnota met min vooraan');
  assert.equal(naarBedrag('45,00-'), -45, 'creditnota met min achteraan');
  assert.equal(naarBedrag('(45,00)'), -45, 'creditnota met haakjes');
  assert.equal(naarBedrag(''), null);
  assert.equal(naarBedrag(null), null);
  assert.equal(naarBedrag('onbekend'), null);
});

test('IBAN wordt zonder spaties en in hoofdletters opgeslagen', () => {
  assert.equal(naarIban('nl91 abna 0417 1643 00'), 'NL91ABNA0417164300');
  assert.equal(naarIban('NL91ABNA0417164300'), 'NL91ABNA0417164300');
  assert.equal(naarIban('DE89 3704 0044 0532 0130 00'), 'DE89370400440532013000');
  assert.equal(naarIban('geen iban'), null);
  assert.equal(naarIban(''), null);
});

test('datums worden genormaliseerd naar YYYY-MM-DD', () => {
  assert.equal(naarDatum('2026-10-04'), '2026-10-04');
  assert.equal(naarDatum('04-10-2026'), '2026-10-04');
  assert.equal(naarDatum('4/10/2026'), '2026-10-04');
  assert.equal(naarDatum('4 okt 2026'), '2026-10-04');
  assert.equal(naarDatum('4 oktober 2026'), '2026-10-04');
  assert.equal(naarDatum('2026-10-04T08:30:00Z'), '2026-10-04');
  assert.equal(naarDatum('geen datum'), null);
  assert.equal(naarDatum(null), null);
});

test('het eerste JSON-object komt ook uit een antwoord met tekst eromheen', () => {
  assert.equal(eersteJsonObject('Hier is het: {"a":1} en verder niks'), '{"a":1}');
  assert.equal(eersteJsonObject('```json\n{"a":{"b":2}}\n```'), '{"a":{"b":2}}');
  assert.equal(eersteJsonObject('{"a":"}"}'), '{"a":"}"}', 'accolade in een string telt niet mee');
  assert.equal(eersteJsonObject('{"a":"\\""}'), '{"a":"\\""}', 'ontsnapte quote');
  assert.equal(eersteJsonObject('geen json'), null);
});

test('een modelantwoord wordt omgezet in onze velden', () => {
  const uit = parseerAntwoord(`Natuurlijk.
\`\`\`json
{"is_invoice": true, "supplier": "Tegelhandel Zuid B.V.", "invoice_number": "2026-0123",
 "invoice_date": "01-10-2026", "due_date": "31 okt 2026", "amount": "1.210,00",
 "currency": "euro", "iban": "nl91 abna 0417 1643 00", "payment_reference": null,
 "description": "XXL tegels"}
\`\`\``);

  assert.equal(uit.isFactuur, true);
  assert.deepEqual(uit.velden, {
    leverancier: 'Tegelhandel Zuid B.V.',
    factuurnummer: '2026-0123',
    factuurdatum: '2026-10-01',
    vervaldatum: '2026-10-31',
    bedrag: 1210,
    valuta: 'EUR',
    iban: 'NL91ABNA0417164300',
    betalingskenmerk: null,
    omschrijving: 'XXL tegels',
  });
});

test('onbekende velden blijven null en is_invoice false wordt overgenomen', () => {
  const uit = parseerAntwoord('{"is_invoice": false, "supplier": null, "amount": null, "iban": "xx"}');
  assert.equal(uit.isFactuur, false);
  assert.equal(uit.velden.leverancier, null);
  assert.equal(uit.velden.bedrag, null);
  assert.equal(uit.velden.iban, null, 'een onzinnige IBAN wordt niet overgenomen');
});

test('een antwoord zonder JSON geeft een leesbare fout', () => {
  assert.throws(() => parseerAntwoord('Dit lijkt me geen factuur.'), /geen JSON/);
  assert.throws(() => parseerAntwoord('{dit is geen json}'), /geldige JSON/);
  assert.throws(() => parseerAntwoord('[1,2,3]'), /geen JSON/);
});

test('tekstUitAntwoord plakt alleen tekstblokken aan elkaar', () => {
  assert.equal(tekstUitAntwoord({ content: [{ type: 'thinking', text: 'x' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(tekstUitAntwoord({}), '');
});

test('de aanroep stuurt de PDF als document-blok met de juiste headers', async () => {
  const fetchFn = nepFetch([antwoordMet('{"is_invoice":true,"supplier":"X","amount":90}')]);
  const claude = maakClaude({ apiKey: 'sleutel-voor-de-test', model: 'claude-sonnet-5-5', fetch: fetchFn });

  const uit = await claude.leesFactuur({ pdf: Buffer.from('%PDF-1.7 nep'), afzender: 'a@b.nl', onderwerp: 'Factuur' });
  assert.equal(uit.velden.bedrag, 90);

  const verzoek = fetchFn.verzoeken[0];
  assert.equal(verzoek.url, API_URL);
  assert.equal(verzoek.opties.headers['anthropic-version'], API_VERSIE);
  assert.equal(verzoek.opties.headers['x-api-key'], 'sleutel-voor-de-test');

  const body = JSON.parse(verzoek.body);
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.output_config.effort, 'low');
  assert.ok(!('thinking' in body), 'thinking wordt niet meegestuurd');
  const blokken = body.messages[0].content;
  assert.equal(blokken[0].type, 'document', 'het document komt vóór de tekst');
  assert.equal(blokken[0].source.media_type, 'application/pdf');
  assert.equal(blokken[0].source.data, Buffer.from('%PDF-1.7 nep').toString('base64'));
  assert.equal(blokken[1].type, 'text');
  assert.match(blokken[1].text, /a@b\.nl/);
});

test('zonder PDF gaat de mailtekst mee en is er geen document-blok', async () => {
  const fetchFn = nepFetch([antwoordMet('{"is_invoice":true,"amount":10}')]);
  const claude = maakClaude({ apiKey: 'k', fetch: fetchFn });
  await claude.leesFactuur({ tekst: 'Te betalen: 10 euro', onderwerp: 'Nota' });

  const blokken = JSON.parse(fetchFn.verzoeken[0].body).messages[0].content;
  assert.equal(blokken.length, 1);
  assert.equal(blokken[0].type, 'text');
  assert.match(blokken[0].text, /Te betalen: 10 euro/);
});

test('een weigering van het model wordt een nette fout, geen leeg resultaat', async () => {
  const fetchFn = nepFetch([{
    json: { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'niet gedaan' } },
  }]);
  const claude = maakClaude({ apiKey: 'k', fetch: fetchFn });
  await assert.rejects(
    () => claude.leesFactuur({ tekst: 'iets' }),
    /weigerde dit document te lezen: niet gedaan/,
  );
});

test('kent het model output_config niet, dan één keer opnieuw zonder effort', async () => {
  const fetchFn = nepFetch([
    { status: 400, tekst: '{"error":{"message":"output_config: unsupported"}}' },
    antwoordMet('{"is_invoice":true,"amount":25}'),
  ]);
  const claude = maakClaude({ apiKey: 'k', model: 'oud-model', fetch: fetchFn });
  const uit = await claude.leesFactuur({ tekst: 'iets' });

  assert.equal(uit.velden.bedrag, 25);
  assert.equal(fetchFn.verzoeken.length, 2);
  assert.ok(!('output_config' in JSON.parse(fetchFn.verzoeken[1].body)), 'tweede poging zonder output_config');
});

test('een geweigerde sleutel en een limiet geven begrijpelijke meldingen', async () => {
  const claude401 = maakClaude({ apiKey: 'k', fetch: nepFetch([{ status: 401, tekst: 'unauthorized' }]) });
  await assert.rejects(() => claude401.leesFactuur({ tekst: 'x' }), /geweigerd \(401\)/);

  // 429 wordt eerst herhaald; met een nepFetch die blijft weigeren eindigt
  // het in de melding over de limiet.
  const claude429 = maakClaude({
    apiKey: 'k',
    fetch: nepFetch([{ status: 429, tekst: 'slow down', headers: { 'retry-after': '0' } }]),
  });
  await assert.rejects(() => claude429.leesFactuur({ tekst: 'x' }), /limiet bereikt/);
});

test('zonder sleutel wordt er niet uitgelezen en niets verzonnen', async () => {
  const claude = maakClaude({ apiKey: '', fetch: nepFetch([]) });
  assert.equal(claude.beschikbaar, false);
  await assert.rejects(() => claude.leesFactuur({ tekst: 'x' }), /geen ANTHROPIC_API_KEY/);
});

test('een bijlagenaam van buiten wordt een veilige bestandsnaam', () => {
  assert.equal(veiligeBestandsnaam('../../etc/passwd'), 'passwd.pdf');
  assert.equal(veiligeBestandsnaam('/tmp/factuur.pdf'), 'factuur.pdf');
  assert.equal(veiligeBestandsnaam('Factuur 2026 #12.PDF'), 'Factuur_2026_12.PDF');
  assert.equal(veiligeBestandsnaam(''), 'bijlage.pdf');
  assert.equal(veiligeBestandsnaam('..'), 'bijlage.pdf');
  assert.ok(!veiligeBestandsnaam('a/b/c.pdf').includes('/'));
});
