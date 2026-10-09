// De mailinterface en de Microsoft 365-adapter, met een nagebootste fetch.
//   node --test test/mail-koppeling.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { controleerKoppeling, KERN, maakMailKoppeling } from '../service/facturen/lib/mail/koppeling.mjs';
import { naarBericht } from '../service/facturen/lib/mail/m365.mjs';
import { maakGraph } from '../service/facturen/lib/graph.mjs';
import { vraag } from '../service/facturen/lib/http.mjs';
import { nepFetch } from './facturen-hulp.mjs';

const TOKEN = { status: 200, json: { access_token: 'tok', expires_in: 3600 } };
const instellingen = { tenantId: 't', clientId: 'c', clientSecret: 's', mailbox: 'info@dekoningtegelwerken.nl' };

test('MAIL_PROVIDER=m365 geeft een adapter met de hele interface', () => {
  const k = maakMailKoppeling({ provider: 'm365', ...instellingen, fetch: nepFetch([TOKEN]) });
  assert.equal(k.provider, 'm365');
  assert.equal(k.beschikbaar, true);
  assert.equal(k.adres, 'info@dekoningtegelwerken.nl');
  for (const naam of KERN) assert.equal(typeof k[naam], 'function', naam);
});

test('een onbekende provider en een halve adapter worden geweigerd', () => {
  assert.throws(() => maakMailKoppeling({ provider: 'gmail' }), /onbekende MAIL_PROVIDER "gmail"/);
  assert.throws(() => controleerKoppeling({ provider: 'x', beschikbaar: true, adres: '' }), /mist: nieuweBerichten/);
});

test('naarBericht herkent agenda, vlag, concept en verwijderd', () => {
  const b = naarBericht({
    '@odata.type': '#microsoft.graph.eventMessageRequest', id: 'm1', internetMessageId: '<a@b>',
    from: { emailAddress: { name: 'Jan', address: 'Jan@Voorbeeld.NL' } },
    flag: { flagStatus: 'flagged' }, isDraft: true, subject: 'Overleg',
  });
  assert.equal(b.soort, 'agenda');
  assert.equal(b.gemarkeerd, true);
  assert.equal(b.concept, true);
  assert.equal(b.afzender.adres, 'jan@voorbeeld.nl');
  assert.equal(naarBericht({ id: 'x', '@removed': { reason: 'deleted' } }).verwijderd, true);
  assert.equal(naarBericht({ id: 'y', '@odata.type': '#microsoft.graph.message' }).soort, 'mail');
});

test('de eerste delta-ronde filtert op "vanaf" en volgt nextLink tot de deltaLink', async () => {
  const fetch = nepFetch([
    TOKEN,
    { status: 200, json: { value: [{ id: 'a' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/volgende' } },
    { status: 200, json: { value: [{ id: 'b' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=1' } },
  ]);
  const k = maakMailKoppeling({ ...instellingen, fetch });
  const uit = await k.nieuweBerichten({ deltaLink: null, vanaf: '2026-10-09T12:00:00Z' });
  assert.deepEqual(uit.berichten.map((b) => b.id), ['a', 'b']);
  assert.equal(uit.deltaLink, 'https://graph.microsoft.com/v1.0/delta?token=1');
  const eerste = decodeURIComponent(fetch.verzoeken[1].url);
  assert.match(eerste, /\/users\/info@dekoningtegelwerken\.nl\/mailFolders\/inbox\/messages\/delta\?/);
  assert.match(eerste, /receivedDateTime ge 2026-10-09T12:00:00Z/);
  assert.equal(fetch.verzoeken[2].url, 'https://graph.microsoft.com/v1.0/volgende');
});

test('een verlopen deltaLink (410) geeft een fout met .verlopen', async () => {
  const k = maakMailKoppeling({ ...instellingen, fetch: nepFetch([TOKEN, { status: 410, tekst: '{"error":{"code":"SyncStateNotFound"}}' }]) });
  await assert.rejects(() => k.nieuweBerichten({ deltaLink: 'https://graph.microsoft.com/v1.0/oud' }), (fout) => fout.verlopen === true);
});

test('verplaatsen geeft het nieuwe id terug', async () => {
  const fetch = nepFetch([TOKEN, { status: 201, json: { id: 'nieuw-id' } }]);
  const k = maakMailKoppeling({ ...instellingen, fetch });
  assert.equal(await k.verplaats('oud-id', 'map-1'), 'nieuw-id');
  assert.match(fetch.verzoeken[1].url, /\/messages\/oud-id\/move$/);
  assert.deepEqual(JSON.parse(fetch.verzoeken[1].body), { destinationId: 'map-1' });
});

test('mapAanmaken zoekt eerst en maakt alleen aan wat ontbreekt', async () => {
  const bestaand = nepFetch([TOKEN, { status: 200, json: { value: [{ id: 'f1', displayName: 'Leveranciers' }] } }]);
  const k1 = maakMailKoppeling({ ...instellingen, fetch: bestaand });
  assert.deepEqual(await k1.mapAanmaken('Leveranciers'), { id: 'f1', naam: 'Leveranciers', nieuw: false });
  assert.equal(bestaand.verzoeken.length, 2, 'geen POST');

  const nieuw = nepFetch([TOKEN, { status: 200, json: { value: [] } }, { status: 201, json: { id: 'f2', displayName: 'Klanten & projecten' } }]);
  const k2 = maakMailKoppeling({ ...instellingen, fetch: nieuw });
  assert.deepEqual(await k2.mapAanmaken('Klanten & projecten'), { id: 'f2', naam: 'Klanten & projecten', nieuw: true });
  assert.equal(nieuw.verzoeken[2].opties.method, 'POST');
  assert.match(decodeURIComponent(nieuw.verzoeken[1].url), /displayName eq 'Klanten & projecten'/);
});

test('categorie voegt toe zonder bestaande categorieën weg te gooien', async () => {
  const fetch = nepFetch([TOKEN, { status: 200, json: { categories: ['Rood'] } }, { status: 200, json: {} }]);
  const k = maakMailKoppeling({ ...instellingen, fetch });
  assert.equal(await k.categorie('m1', 'Controleren'), true);
  assert.deepEqual(JSON.parse(fetch.verzoeken[2].body), { categories: ['Rood', 'Controleren'] });
  assert.equal(fetch.verzoeken[2].opties.method, 'PATCH');
});

test('inhoud geeft hooguit 1500 tekens en alleen de namen van echte bijlagen', async () => {
  const lang = 'woord '.repeat(1000);
  const fetch = nepFetch([
    TOKEN,
    { status: 200, json: { body: { content: lang } } },
    { status: 200, json: { value: [{ name: 'factuur.pdf', isInline: false }, { name: 'logo.png', isInline: true }] } },
  ]);
  const k = maakMailKoppeling({ ...instellingen, fetch });
  const uit = await k.inhoud('m1');
  assert.ok(uit.tekst.length <= 1500);
  assert.deepEqual(uit.bijlagen, ['factuur.pdf']);
  assert.match(fetch.verzoeken[2].url, /attachments\?\$select=name,isInline$/);
});

test('webhook-subscription: created op de Inbox van één mailbox, met clientState', async () => {
  const fetch = nepFetch([TOKEN, { status: 201, json: { id: 'sub-1', expirationDateTime: '2026-10-12T10:00:00Z' } }]);
  const k = maakMailKoppeling({ ...instellingen, fetch });
  const uit = await k.webhook.maak({ notificatieUrl: 'https://cms.dekoningtegelwerken.nl/graph/notify', clientState: 'geheim', verlooptOp: '2026-10-12T10:00:00Z' });
  assert.deepEqual(uit, { id: 'sub-1', verlooptOp: '2026-10-12T10:00:00Z' });
  const body = JSON.parse(fetch.verzoeken[1].body);
  assert.equal(fetch.verzoeken[1].url, 'https://graph.microsoft.com/v1.0/subscriptions');
  assert.equal(body.changeType, 'created');
  assert.equal(body.resource, "users/info@dekoningtegelwerken.nl/mailFolders('inbox')/messages");
  assert.equal(body.clientState, 'geheim');
});

test('429 en 503 wachten de Retry-After af en proberen opnieuw', async () => {
  const gewacht = [];
  const fetch = nepFetch([
    { status: 429, headers: { 'retry-after': '7' } },
    { status: 503, headers: { 'retry-after': '2' } },
    { status: 200, json: {} },
  ]);
  const antwoord = await vraag(fetch, 'https://graph.microsoft.com/x', {}, { wacht: async (ms) => { gewacht.push(ms); } });
  assert.equal(antwoord.status, 200);
  assert.deepEqual(gewacht, [7000, 2000]);
});

test('de verbindingstest kijkt echt in de mailbox, niet naar een roles-claim', async () => {
  // Token zonder roles (zoals bij RBAC for Applications) en een mailbox die
  // antwoordt: in orde.
  const fetch = nepFetch([
    TOKEN,
    { status: 200, json: { id: 'inbox', displayName: 'Inbox' } },
    { status: 200, json: { value: [{ id: 'f', displayName: 'Facturen' }] } },
  ]);
  const g = maakGraph({ ...instellingen, fetch });
  const uit = await g.test();
  assert.equal(uit.ok, true);
  assert.match(uit.melding, /Facturen/);
  assert.match(fetch.verzoeken[1].url, /\/users\/info%40dekoningtegelwerken\.nl\/mailFolders\/inbox/);
});
