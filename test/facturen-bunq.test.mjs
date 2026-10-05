// bunq: de ondertekening, het omzetten van betalingen en de opbouw van
// installatie en sessie met een nagebootste fetch.
//   node --test test/facturen-bunq.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  SANDBOX_URL, PRODUCTIE_URL, alleUitResponse, basisUrl, maakBunq, maakSleutelpaar,
  naarBetaling, ondertekenLichaam, uitResponse, verifieerLichaam,
} from '../service/facturen/lib/bunq.mjs';
import { nepFetch, ruimOp, tijdelijkeOpslag } from './facturen-hulp.mjs';

after(ruimOp);

test('de handtekening over de body is met de publieke sleutel te verifiëren', () => {
  const { privateKey, publicKey } = maakSleutelpaar();
  const lichaam = JSON.stringify({ secret: 'niet-echt', description: 'test' });

  const handtekening = ondertekenLichaam(privateKey, lichaam);
  assert.ok(handtekening.length > 300, 'base64 van een RSA-2048-handtekening');
  assert.equal(verifieerLichaam(publicKey, lichaam, handtekening), true);

  // Dezelfde controle nog eens met node:crypto zelf, zodat de test niet
  // alleen onze eigen verifieerfunctie bevestigt.
  assert.equal(crypto.verify('sha256', Buffer.from(lichaam, 'utf8'), {
    key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING,
  }, Buffer.from(handtekening, 'base64')), true);

  assert.equal(verifieerLichaam(publicKey, lichaam + ' ', handtekening), false, 'een gewijzigde body valt af');
  const ander = maakSleutelpaar();
  assert.equal(verifieerLichaam(ander.publicKey, lichaam, handtekening), false, 'een andere sleutel valt af');
});

test('basisUrl kiest productie of sandbox', () => {
  assert.equal(basisUrl('production'), PRODUCTIE_URL);
  assert.equal(basisUrl('sandbox'), SANDBOX_URL);
  assert.equal(basisUrl(undefined), PRODUCTIE_URL);
});

test('uitResponse en alleUitResponse pakken de juiste sleutels', () => {
  const data = { Response: [{ Id: { id: 1 } }, { Token: { token: 'abc' } }] };
  assert.deepEqual(uitResponse(data, 'Token'), { token: 'abc' });
  assert.equal(uitResponse(data, 'Bestaat niet'), null);
  assert.deepEqual(alleUitResponse({ Response: [{ Payment: { id: 1 } }, { Payment: { id: 2 } }] }, ['Payment']),
    [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(alleUitResponse(null, ['Payment']), []);
});

test('een bunq-betaling wordt omgezet naar onze kolommen', () => {
  const betaling = naarBetaling({
    id: 8811,
    created: '2026-10-05 11:22:33.123456',
    amount: { value: '-1210.00', currency: 'EUR' },
    description: 'Factuur 2026-0123',
    counterparty_alias: { iban: 'nl91 abna 0417 1643 00', display_name: 'Tegelhandel Zuid B.V.' },
  }, { id: '42', iban: 'NL00BUNQ0000000001' });

  assert.deepEqual(betaling, {
    id: '8811',
    rekening_id: '42',
    rekening_iban: 'NL00BUNQ0000000001',
    datum: '2026-10-05',
    bedrag: -1210,
    valuta: 'EUR',
    tegenrekening_iban: 'NL91ABNA0417164300',
    tegenpartij_naam: 'Tegelhandel Zuid B.V.',
    omschrijving: 'Factuur 2026-0123',
  });
});

test('de tegenpartij komt ook uit label_monetary_account', () => {
  const betaling = naarBetaling({
    id: 1, created: '2026-01-02 00:00:00', amount: { value: '-10.00', currency: 'EUR' },
    counterparty_alias: { label_monetary_account: { iban: 'NL02ABNA0123456789', display_name: 'Groothandel' } },
  }, { id: '1', iban: null });
  assert.equal(betaling.tegenrekening_iban, 'NL02ABNA0123456789');
  assert.equal(betaling.tegenpartij_naam, 'Groothandel');
});

// Antwoorden in de volgorde waarin de opbouw ze opvraagt.
function nepBunqFetch() {
  return nepFetch([
    { json: { Response: [{ Id: { id: 1 } }, { Token: { token: 'installatie-token' } }, { ServerPublicKey: { server_public_key: 'pem' } }] } },
    { json: { Response: [{ Id: { id: 2 } }] } },
    { json: { Response: [{ Token: { token: 'sessie-token' } }, { UserPerson: { id: 777 } }] } },
    {
      json: {
        Response: [{
          MonetaryAccountBank: {
            id: 42, status: 'ACTIVE', description: 'Zakelijk',
            alias: [{ type: 'IBAN', value: 'NL00BUNQ0000000001', name: 'De Koning' }],
          },
        }, {
          MonetaryAccountBank: { id: 43, status: 'CANCELLED', alias: [{ type: 'IBAN', value: 'NL00BUNQ0000000009' }] },
        }],
      },
    },
    {
      json: {
        Response: [{
          Payment: {
            id: 9001, created: '2026-10-05 09:00:00',
            amount: { value: '-1210.00', currency: 'EUR' }, description: 'Factuur 2026-0123',
            counterparty_alias: { iban: 'NL91ABNA0417164300', display_name: 'Tegelhandel Zuid' },
          },
        }],
        Pagination: {},
      },
    },
  ]);
}

test('installatie, apparaat en sessie worden één keer opgebouwd en bewaard', async () => {
  const { map } = tijdelijkeOpslag();
  const statePad = path.join(map, 'bunq_state.json');
  const fetchFn = nepBunqFetch();
  const bunq = maakBunq({ apiKey: 'niet-echte-sleutel', statePad, fetch: fetchFn });

  const rekeningen = await bunq.rekeningen();
  assert.deepEqual(rekeningen, [{ id: '42', iban: 'NL00BUNQ0000000001', naam: 'Zakelijk' }],
    'alleen de actieve rekening');

  const paden = fetchFn.verzoeken.map((v) => v.url.replace(PRODUCTIE_URL, ''));
  assert.deepEqual(paden.slice(0, 3), ['/installation', '/device-server', '/session-server']);

  // /installation gaat zonder sessietoken; de andere twee met het
  // installatietoken, en alle drie met een handtekening over de body.
  const [installatie, apparaat, sessie] = fetchFn.verzoeken;
  assert.equal(installatie.opties.headers['x-bunq-client-authentication'], undefined);
  assert.equal(apparaat.opties.headers['x-bunq-client-authentication'], 'installatie-token');
  assert.equal(sessie.opties.headers['x-bunq-client-authentication'], 'installatie-token');

  const state = JSON.parse(readFileSync(statePad, 'utf8'));
  assert.ok(verifieerLichaam(state.publicKey, apparaat.body, apparaat.opties.headers['x-bunq-client-signature']),
    'de handtekening hoort bij de bewaarde sleutel');

  // Vaste headers die bunq verwacht.
  assert.equal(apparaat.opties.headers['x-bunq-language'], 'nl_NL');
  assert.equal(apparaat.opties.headers['x-bunq-region'], 'nl_NL');
  assert.equal(apparaat.opties.headers['x-bunq-geolocation'], '0 0 0 0 000');
  assert.equal(apparaat.opties.headers['cache-control'], 'no-cache');
  assert.match(apparaat.opties.headers['x-bunq-client-request-id'], /^[0-9a-f-]{36}$/);

  assert.equal(state.sessieToken, 'sessie-token');
  assert.equal(state.userId, '777');
  assert.equal(statSync(statePad).mode & 0o777, 0o600, 'de state staat op 600');
  assert.ok(!JSON.stringify(state).includes('niet-echte-sleutel'), 'de API-key staat niet in de state');
});

test('een GET wordt niet ondertekend en gebruikt het sessietoken', async () => {
  const { map } = tijdelijkeOpslag();
  const fetchFn = nepBunqFetch();
  const bunq = maakBunq({ apiKey: 'k', statePad: path.join(map, 'bunq_state.json'), fetch: fetchFn });
  await bunq.rekeningen();

  const lezen = fetchFn.verzoeken[3];
  assert.match(lezen.url, /\/user\/777\/monetary-account/);
  assert.equal(lezen.opties.headers['x-bunq-client-authentication'], 'sessie-token');
  assert.equal(lezen.opties.headers['x-bunq-client-signature'], undefined);
  assert.equal(lezen.opties.method, 'GET');
});

test('betalingen worden gefilterd op de terugkijkperiode', async () => {
  const { map } = tijdelijkeOpslag();
  const bunq = maakBunq({ apiKey: 'k', statePad: path.join(map, 'bunq_state.json'), fetch: nepBunqFetch() });

  const binnen = await bunq.betalingen({ vanafDatum: '2026-01-01' });
  assert.equal(binnen.length, 1);
  assert.equal(binnen[0].id, '9001');

  const { map: map2 } = tijdelijkeOpslag();
  const bunq2 = maakBunq({ apiKey: 'k', statePad: path.join(map2, 'bunq_state.json'), fetch: nepBunqFetch() });
  const buiten = await bunq2.betalingen({ vanafDatum: '2026-11-01' });
  assert.equal(buiten.length, 0, 'wat buiten de periode valt komt er niet in');
});

test('het IBAN-filter laat alleen de opgegeven rekening door', async () => {
  const { map } = tijdelijkeOpslag();
  const bunq = maakBunq({
    apiKey: 'k', statePad: path.join(map, 'bunq_state.json'),
    ibanFilter: ['NL99ANDER0000000000'], fetch: nepBunqFetch(),
  });
  assert.deepEqual(await bunq.rekeningen(), []);
});

test('een andere API-key laat de installatie opnieuw opbouwen', async () => {
  const { map } = tijdelijkeOpslag();
  const statePad = path.join(map, 'bunq_state.json');

  const eerste = maakBunq({ apiKey: 'sleutel-een', statePad, fetch: nepBunqFetch() });
  await eerste.rekeningen();
  const sleutelEen = JSON.parse(readFileSync(statePad, 'utf8')).publicKey;

  const tweede = maakBunq({ apiKey: 'sleutel-twee', statePad, fetch: nepBunqFetch() });
  await tweede.rekeningen();
  const sleutelTwee = JSON.parse(readFileSync(statePad, 'utf8')).publicKey;

  assert.notEqual(sleutelEen, sleutelTwee, 'nieuw sleutelpaar bij een nieuwe API-key');
});

test('zonder sleutel is bunq niet beschikbaar en wordt de stap overgeslagen', async () => {
  const bunq = maakBunq({ apiKey: '', statePad: '/tmp/bestaat-niet.json', fetch: nepFetch([]) });
  assert.equal(bunq.beschikbaar, false);
  assert.deepEqual(await bunq.test(), { ok: false, melding: 'bunq is niet ingesteld in de env.' });
  await assert.rejects(() => bunq.betalingen({ vanafDatum: '2026-01-01' }), /niet ingesteld/);
});

test('de verbindingstest meldt een IP-probleem met een hint', async () => {
  const { map } = tijdelijkeOpslag();
  const fetchFn = nepFetch([{
    status: 400,
    tekst: JSON.stringify({ Error: [{ error_description: 'Insufficient authentication: IP address not permitted' }] }),
  }]);
  const bunq = maakBunq({ apiKey: 'k', statePad: path.join(map, 'bunq_state.json'), fetch: fetchFn });
  const uit = await bunq.test();
  assert.equal(uit.ok, false);
  assert.match(uit.melding, /IP address not permitted/);
  assert.match(uit.melding, /publieke IP van hfd-web01/);
});
