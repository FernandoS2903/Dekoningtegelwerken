// Noodtoegang (lib/breakglass.mjs): tailnet-check, scrypt, TOTP (RFC 6238),
// de route /breakglass via een echte http-server in SSO-modus (404 van
// buiten, formulier, limiet, replay, sessie met banner, uitloggen, melding),
// en de bewaking van de vervaldatum van het client secret.
//   node --test test/breakglass.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { maakFacturenApp } from '../service/facturen/server.mjs';
import { maakPortaal } from '../service/facturen/portaal.mjs';
import { maakMailApp } from '../service/facturen/mail.mjs';
import { maakSorteerOpslag } from '../service/facturen/lib/sorteer-opslag.mjs';
import { maakSorteerder } from '../service/facturen/lib/sorteren.mjs';
import { maakWebhook } from '../service/facturen/lib/webhook.mjs';
import { maakSessies } from '../service/facturen/lib/sessies.mjs';
import { maakOidc } from '../service/facturen/lib/oidc.mjs';
import * as instellingen from '../service/facturen/lib/instellingen.mjs';
import {
  inTailnet, maakWachtwoordHash, controleerWachtwoord, leesWachtwoordHash, base32Encode, base32Decode,
  totpCode, totpStap, controleerTotp, otpauthUri, maakBreakglass, LIMIET,
} from '../service/facturen/lib/breakglass.mjs';
import { dagenTotVerloop, secretWaarschuwing, maakSecretControle } from '../service/facturen/lib/secretverloop.mjs';
import { BASIS, CLIENT, GEHEIM, TENANT, nepEntra } from './portaal-hulp.mjs';
import { bericht, nepClassificeerder, nepMailbox } from './mail-hulp.mjs';
import { nepGraph, ruimOp, tijdelijkeOpslag } from './facturen-hulp.mjs';

// RFC 6238, bijlage B: geheim "12345678901234567890" (SHA-1, 6 van de 8 cijfers).
const RFC_GEHEIM = base32Encode(Buffer.from('12345678901234567890'));

test('inTailnet: alleen 100.64.0.0/10, ook met IPv4-mapped prefix', () => {
  for (const ip of ['100.64.0.1', '100.86.87.92', '100.127.255.255', '::ffff:100.100.1.1']) assert.equal(inTailnet(ip), true, ip);
  for (const ip of ['100.63.255.255', '100.128.0.0', '100.24.121.183', '100.50.65.86', '10.0.0.1', '127.0.0.1', '', 'x', '100.64.0.256', '2001:db8::1']) assert.equal(inTailnet(ip), false, ip);
});

test('scrypt: hash met parameters en zout, controle klopt, verkeerd wachtwoord en kapotte hash niet', () => {
  const hash = maakWachtwoordHash('een-lang-genoeg-wachtwoord');
  assert.match(hash, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notEqual(hash, maakWachtwoordHash('een-lang-genoeg-wachtwoord'), 'ander zout, andere hash');
  assert.equal(controleerWachtwoord('een-lang-genoeg-wachtwoord', hash), true);
  assert.equal(controleerWachtwoord('een-lang-genoeg-wachtwoorD', hash), false);
  assert.equal(controleerWachtwoord('x', 'argon2id$whatever'), false);
  assert.equal(controleerWachtwoord('x', ''), false);
  assert.equal(leesWachtwoordHash('scrypt$2097152$8$1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='), null, 'N te groot');
});

test('base32 en TOTP: de testvectoren uit RFC 6238', () => {
  assert.equal(RFC_GEHEIM, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq').toString(), '12345678901234567890');
  assert.equal(base32Decode('abc1'), null);
  const g = base32Decode(RFC_GEHEIM);
  assert.equal(totpCode(g, totpStap(59 * 1000)), '287082');
  assert.equal(totpCode(g, totpStap(1111111109 * 1000)), '081804');
  assert.equal(totpCode(g, totpStap(1234567890 * 1000)), '005924');
  assert.equal(totpCode(g, totpStap(20000000000 * 1000)), '353130');
  /* speling van één stap voor en na; daarbuiten niet */
  const nu = 1234567890 * 1000;
  assert.equal(controleerTotp(RFC_GEHEIM, '005924', { nu }), totpStap(nu));
  assert.equal(controleerTotp(RFC_GEHEIM, totpCode(g, totpStap(nu) - 1), { nu }), totpStap(nu) - 1);
  assert.equal(controleerTotp(RFC_GEHEIM, totpCode(g, totpStap(nu) + 2), { nu }), null);
  assert.equal(controleerTotp(RFC_GEHEIM, '00592', { nu }), null);
  assert.equal(controleerTotp('', '005924', { nu }), null);
  assert.equal(otpauthUri({ uitgever: 'DKT Portaal', account: 'bob', geheimB32: RFC_GEHEIM }), `otpauth://totp/DKT%20Portaal%3Abob?secret=${RFC_GEHEIM}&issuer=DKT+Portaal&algorithm=SHA1&digits=6&period=30`);
});

test('vervaldatum client secret: waarschuwing vanaf 30 dagen, verlopen, ontbrekend of ongeldig', async () => {
  const nu = Date.UTC(2026, 9, 13);
  assert.equal(dagenTotVerloop('2026-11-12', nu), 30);
  assert.equal(secretWaarschuwing('2027-01-01', nu), null);
  assert.match(secretWaarschuwing('2026-11-12', nu), /verloopt over 30 dagen \(2026-11-12\)/);
  assert.match(secretWaarschuwing('2026-10-14', nu), /verloopt over 1 dag \(/);
  assert.match(secretWaarschuwing('2026-10-10', nu), /3 dagen geleden verlopen/);
  assert.match(secretWaarschuwing('', nu), /staat niet in de env/);
  assert.match(secretWaarschuwing('volgende week', nu), /geen datum/);
  const mails = [];
  const logs = [];
  const controle = maakSecretControle({ verloopt: '2026-10-20', nu: () => nu, log: (n, t) => logs.push(n + ' ' + t), mail: { beschikbaar: true, verstuurMail: async (m) => mails.push(m) }, naar: 'bob@voorbeeld.nl' });
  await controle(); await controle();
  assert.equal(logs.length, 2);
  assert.equal(mails.length, 1, 'één mail per dag');
  assert.equal(mails[0].aan, 'bob@voorbeeld.nl');
});

// -- de route, via een echte server in SSO-modus --------------------------------
const WACHTWOORD = 'noodwachtwoord-van-voldoende-lengte';
const klok = { nu: 1760000000 * 1000 };
let p;
const meldingen = [];

async function bouw() {
  const { opslag, pdfMap } = tijdelijkeOpslag();
  const sorteerOpslag = maakSorteerOpslag(opslag.db);
  const ontvangen = new Date(Date.now() + 60 * 1000).toISOString();
  const mail = nepMailbox({ rondes: [[bericht({ id: 'w1', adres: 'jan@klant.nl', onderwerp: 'Badkamer', ontvangen })]] });
  mail.webhook = { async maak(o) { return { id: 'sub-1', verlooptOp: o.verlooptOp }; }, async verleng() {}, async verwijder() {} };
  const facturen = maakFacturenApp({ opslag, graph: nepGraph(), pdfMap, basisPad: '/facturen', nu: () => '2026-10-13' });
  const sorteerder = maakSorteerder({ sorteerOpslag, mail, classificeerder: nepClassificeerder(), instellingenLezer: () => instellingen.lees(opslag) });
  const webhook = maakWebhook({ mail, sorteerOpslag, sorteerder, geheim: 'x'.repeat(40), notificatieUrl: '', actief: false });
  const mailApp = maakMailApp({ opslag, sorteerOpslag, sorteerder, webhook, mail, classificeerder: nepClassificeerder(), basisPad: '/mail' });
  const entra = nepEntra();
  const sessies = maakSessies({ db: opslag.db, geheim: GEHEIM });
  const oidc = maakOidc({ tenantId: TENANT, clientId: CLIENT, clientSecret: 's', baseUrl: BASIS, toegestaan: ['bob@dekoningtegelwerken.nl'], pogingen: sessies.pogingen, fetch: entra.fetch });
  const breakglass = maakBreakglass({
    gebruiker: 'nood-bob', wachtwoordHash: maakWachtwoordHash(WACHTWOORD), totpGeheim: RFC_GEHEIM, sessies, db: opslag.db,
    log: (n, b) => opslag.log(n, b), meld: async (m) => { meldingen.push(m); }, nu: () => klok.nu,
  });
  assert.equal(breakglass.beschikbaar, true);
  const auth = { modus: 'sso', sessies, oidc, breakglass };
  const { server } = maakPortaal({ opslag, sorteerOpslag, facturen, mailApp, webhook, auth, offertesUrl: '' });
  await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
  await sorteerder.draai();
  return { server, adres: `http://127.0.0.1:${server.address().port}`, opslag, sessies, breakglass };
}
before(async () => { p = await bouw(); });
after(async () => { await new Promise((r) => p.server.close(r)); ruimOp(); });

const haal = (pad, opties = {}) => fetch(p.adres + pad, { redirect: 'manual', ...opties });
const code = () => totpCode(base32Decode(RFC_GEHEIM), totpStap(klok.nu));
function inlog(velden, { ip = '100.86.87.92', herkomst = 'same-origin' } = {}) {
  return haal('/breakglass', {
    method: 'POST', body: new URLSearchParams(velden),
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': ip, ...(herkomst ? { 'sec-fetch-site': herkomst } : {}) },
  });
}

test('/breakglass bestaat niet zonder X-Real-IP of van buiten de tailnet; wel vanaf de tailnet', async () => {
  assert.equal((await haal('/breakglass')).status, 404);
  assert.equal((await haal('/breakglass', { headers: { 'x-real-ip': '100.24.121.183' } })).status, 404);
  assert.equal((await haal('/breakglass', { headers: { 'x-real-ip': '84.107.110.110' } })).status, 404);
  assert.equal((await haal('/breakglass', { method: 'POST', headers: { 'x-real-ip': '1.2.3.4', 'sec-fetch-site': 'same-origin' } })).status, 404);
  const ok = await haal('/breakglass', { headers: { 'x-real-ip': '100.86.87.92' } });
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.match(html, /Noodtoegang/);
  assert.match(html, /name="gebruiker"/);
  assert.match(html, /name="code"[^>]*autocomplete="one-time-code"/);
  assert.doesNotMatch(html, /_csrf/);
});

test('verkeerde gegevens: 401 met melding, in de log; na vijf pogingen 429', async () => {
  const fout = await inlog({ gebruiker: 'nood-bob', wachtwoord: 'fout', code: code() }, { ip: '100.100.0.5' });
  assert.equal(fout.status, 401);
  assert.match(await fout.text(), /klopt niet/);
  assert.equal((await inlog({ gebruiker: 'iemand', wachtwoord: WACHTWOORD, code: code() }, { ip: '100.100.0.5' })).status, 401);
  assert.equal((await inlog({ gebruiker: 'nood-bob', wachtwoord: WACHTWOORD, code: '000000' }, { ip: '100.100.0.5' })).status, 401);
  assert.equal((await inlog({ gebruiker: 'nood-bob', wachtwoord: WACHTWOORD, code: code() }, { ip: '100.100.0.5', herkomst: null })).status, 403, 'zonder herkomst');
  assert.equal((await inlog({ gebruiker: 'nood-bob', wachtwoord: 'fout', code: code() }, { ip: '100.100.0.5' })).status, 401);
  assert.equal((await inlog({ gebruiker: 'nood-bob', wachtwoord: 'fout', code: code() }, { ip: '100.100.0.5' })).status, 401);
  assert.equal(p.breakglass.pogingen('100.100.0.5'), LIMIET.pogingen);
  /* de zesde, ook met de juiste gegevens: dicht */
  const dicht = await inlog({ gebruiker: 'nood-bob', wachtwoord: WACHTWOORD, code: code() }, { ip: '100.100.0.5' });
  assert.equal(dicht.status, 429);
  assert.equal((await haal('/breakglass', { headers: { 'x-real-ip': '100.100.0.5' } })).status, 429);
  /* een ander adres heeft er geen last van */
  assert.equal((await haal('/breakglass', { headers: { 'x-real-ip': '100.100.0.6' } })).status, 200);
  const log = p.opslag.db.prepare("SELECT COUNT(*) n FROM breakglass_log WHERE ip = '100.100.0.5' AND geslaagd = 0").get().n;
  assert.ok(log >= 5);
  /* na het venster weer open */
  klok.nu += LIMIET.vensterMs + 1000;
  assert.equal((await haal('/breakglass', { headers: { 'x-real-ip': '100.100.0.5' } })).status, 200);
});

test('geslaagde login: sessie met auth_method breakglass, banner, melding, dezelfde code niet nog een keer, uitloggen zonder Microsoft', async () => {
  const gebruikt = code();
  const ok = await inlog({ gebruiker: 'nood-bob', wachtwoord: WACHTWOORD, code: gebruikt });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/');
  const cookie = ok.headers.getSetCookie().find((c) => c.startsWith('__Host-dkt_sessie='));
  assert.ok(cookie, 'sessiecookie');
  assert.match(cookie, /Secure; HttpOnly; SameSite=Lax/);
  const token = cookie.split(';')[0];
  assert.equal(meldingen.length, 1);
  assert.equal(meldingen[0].gebruiker, 'nood-bob');
  assert.equal(meldingen[0].ip, '100.86.87.92');
  const rij = p.opslag.db.prepare('SELECT email, naam, auth_method FROM sessies').get();
  assert.deepEqual({ ...rij }, { email: 'nood-bob', naam: 'Break-glass (nood-bob)', auth_method: 'breakglass' });

  /* dezelfde sessie als SSO: dashboard, /auth/check, met banner */
  const dashboard = await haal('/', { headers: { cookie: token } });
  assert.equal(dashboard.status, 200);
  const html = await dashboard.text();
  assert.match(html, /Ingelogd via break-glass/);
  assert.match(html, /break-glass · noodtoegang/);
  const check = await haal('/auth/check', { headers: { cookie: token } });
  assert.equal(check.status, 200);
  assert.equal(check.headers.get('x-portal-user'), 'nood-bob');
  assert.equal((await haal('/mail/', { headers: { cookie: token } })).status, 200);

  /* replay: dezelfde code binnen hetzelfde venster wordt geweigerd */
  const nogmaals = await inlog({ gebruiker: 'nood-bob', wachtwoord: WACHTWOORD, code: gebruikt }, { ip: '100.86.87.93' });
  assert.equal(nogmaals.status, 401);
  assert.equal(p.opslag.db.prepare("SELECT reden FROM breakglass_log WHERE ip = '100.86.87.93' ORDER BY id DESC LIMIT 1").get().reden, 'code al gebruikt');

  /* uitloggen: sessie weg, niet naar Microsoft */
  const csrf = (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  const uit = await haal('/auth/logout', { method: 'POST', body: new URLSearchParams({ _csrf: csrf }), headers: { cookie: token, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' } });
  assert.equal(uit.status, 303);
  assert.equal(uit.headers.get('location'), '/auth/uitgelogd');
  assert.equal((await haal('/', { headers: { cookie: token } })).status, 302, 'sessie is weg');
  assert.match((await p.opslag.db.prepare("SELECT bericht FROM logboek WHERE bericht LIKE 'break-glass geslaagd%' LIMIT 1").get())?.bericht || '', /ip 100\.86\.87\.92/);
});

test('zonder instellingen bestaat de route wel voor de tailnet, maar meldt hij dat hij uit staat', async () => {
  const { opslag } = tijdelijkeOpslag();
  const sessies = maakSessies({ db: opslag.db, geheim: GEHEIM });
  const uit = maakBreakglass({ gebruiker: '', wachtwoordHash: '', totpGeheim: '', sessies, db: opslag.db });
  assert.equal(uit.beschikbaar, false);
  const half = maakBreakglass({ gebruiker: 'x', wachtwoordHash: 'scrypt$kapot', totpGeheim: RFC_GEHEIM, sessies, db: opslag.db });
  assert.equal(half.beschikbaar, false);
});
