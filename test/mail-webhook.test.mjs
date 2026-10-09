// De webhook voor Graph change notifications (lib/webhook.mjs).
//   node --test test/mail-webhook.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { maakWebhook, VERLENG_ONDER_MS } from '../service/facturen/lib/webhook.mjs';
import { HttpFout } from '../service/facturen/lib/http.mjs';
import { nepMailbox, sorteerOpslagen } from './mail-hulp.mjs';
import { ruimOp } from './facturen-hulp.mjs';

after(ruimOp);

const GEHEIM = 'een-lang-webhook-geheim-voor-de-test';
const URL_NOTIFY = 'https://cms.dekoningtegelwerken.nl/graph/notify';

function opzet({ actief = true, klok = Date.parse('2026-10-09T12:00:00Z') } = {}) {
  const { sorteerOpslag } = sorteerOpslagen();
  const mail = nepMailbox();
  const rondes = [];
  const sorteerder = { async draai(a) { rondes.push(a); return {}; } };
  const tijd = { nu: klok };
  const gemaakt = [];
  const verlengd = [];
  mail.webhook = {
    async maak(opties) { gemaakt.push(opties); return { id: 'sub-' + gemaakt.length, verlooptOp: opties.verlooptOp }; },
    async verleng(id, verlooptOp) { verlengd.push({ id, verlooptOp }); return { id, verlooptOp }; },
    async verwijder() {},
  };
  const webhook = maakWebhook({
    mail, sorteerOpslag, sorteerder, geheim: GEHEIM, notificatieUrl: URL_NOTIFY, actief, nu: () => tijd.nu,
  });
  return { webhook, mail, sorteerOpslag, rondes, gemaakt, verlengd, tijd };
}

const notificatie = (clientState) => JSON.stringify({
  value: [{ subscriptionId: 'sub-1', clientState, changeType: 'created', resource: 'x' }],
});

test('zolang cms. niet publiek is: geen subscription en /graph/notify bestaat niet', async () => {
  const { webhook, gemaakt } = opzet({ actief: false });
  assert.deepEqual(await webhook.onderhoud(), { actief: false });
  assert.equal(gemaakt.length, 0);
  assert.equal(webhook.verwerk({ methode: 'POST', zoekparams: new URLSearchParams(), body: notificatie(GEHEIM) }).status, 404);
  assert.match(webhook.status().reden, /alleen polling/);
});

test('validationToken wordt alleen teruggegeven terwijl we zelf een subscription aanmaken', async () => {
  const { webhook, mail } = opzet();
  const zoek = new URLSearchParams({ validationToken: 'Validation: Token 123' });
  assert.equal(webhook.verwerk({ methode: 'POST', zoekparams: zoek, body: '' }).status, 400, 'niet gevraagd');

  let tijdensAanmaken;
  const origineel = mail.webhook.maak;
  mail.webhook.maak = async (opties) => {
    tijdensAanmaken = webhook.verwerk({ methode: 'POST', zoekparams: zoek, body: '' });
    return origineel(opties);
  };
  await webhook.onderhoud();
  assert.deepEqual(tijdensAanmaken, { status: 200, tekst: 'Validation: Token 123', letterlijk: true });
  assert.equal(webhook.verwerk({ methode: 'POST', zoekparams: zoek, body: '' }).status, 400, 'daarna weer dicht');
});

test('een verkeerde clientState geeft 401 en start geen ronde', () => {
  const { webhook, rondes } = opzet();
  const leeg = new URLSearchParams();
  assert.equal(webhook.verwerk({ methode: 'POST', zoekparams: leeg, body: notificatie('fout') }).status, 401);
  assert.equal(webhook.verwerk({ methode: 'POST', zoekparams: leeg, body: notificatie(undefined) }).status, 401);
  const gemengd = JSON.stringify({ value: [{ clientState: GEHEIM }, { clientState: 'fout' }] });
  assert.equal(webhook.verwerk({ methode: 'POST', zoekparams: leeg, body: gemengd }).status, 401);
  assert.equal(webhook.verwerk({ methode: 'POST', zoekparams: leeg, body: 'geen json' }).status, 400);
  assert.equal(rondes.length, 0);
});

test('een juiste clientState geeft 202 en start alleen de delta-ronde', () => {
  const { webhook, rondes } = opzet();
  const uit = webhook.verwerk({ methode: 'POST', zoekparams: new URLSearchParams(), body: notificatie(GEHEIM) });
  assert.equal(uit.status, 202);
  assert.deepEqual(rondes, [{ aanleiding: 'webhook' }]);
  assert.ok(webhook.status().laatsteNotificatie);
});

test('de subscription wordt aangemaakt, op tijd verlengd en opnieuw gemaakt als hij weg is', async () => {
  const { webhook, gemaakt, verlengd, tijd, mail, sorteerOpslag } = opzet();

  await webhook.onderhoud();
  assert.equal(gemaakt.length, 1);
  assert.equal(gemaakt[0].notificatieUrl, URL_NOTIFY);
  assert.equal(gemaakt[0].clientState, GEHEIM);
  assert.equal(sorteerOpslag.staat('sub_id'), 'sub-1');
  const verloopt = Date.parse(sorteerOpslag.staat('sub_verloopt'));
  assert.equal(verloopt - tijd.nu, 3 * 24 * 3600 * 1000, 'drie dagen');

  await webhook.onderhoud();
  assert.equal(verlengd.length, 0, 'nog ruim geldig');

  tijd.nu = verloopt - VERLENG_ONDER_MS + 1000;
  await webhook.onderhoud();
  assert.equal(verlengd.length, 1, 'minder dan een dag over: verlengd');
  assert.equal(webhook.status().verlooptOp, verlengd[0].verlooptOp);

  mail.webhook.verleng = async () => { throw new HttpFout(404, 'weg', 'x'); };
  tijd.nu = Date.parse(sorteerOpslag.staat('sub_verloopt')) - 1000;
  await webhook.onderhoud();
  assert.equal(gemaakt.length, 2, 'opnieuw aangemaakt');
});

test('een mislukte aanmaak wordt bewaard als status en de polling blijft het vangnet', async () => {
  const { webhook, mail } = opzet();
  mail.webhook.maak = async () => { throw new Error('400 bij subscriptions: validatie mislukt'); };
  const uit = await webhook.onderhoud();
  assert.match(uit.fout, /validatie mislukt/);
  assert.match(webhook.status().fout, /validatie mislukt/);
});
