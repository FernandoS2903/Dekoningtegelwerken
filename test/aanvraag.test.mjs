// Het aanvraagformulier van de website: POST /api/aanvraag/indienen zonder
// login, met de controles (herkomst, honeypot, invultijd, velden, bestanden,
// limieten), de opslag, en de wachtrij naar de mailbox en Offerteknop
// (nagebootst; geen echte mail, geen netwerk). Ook de omzetting naar het
// contract van Offerteknop en de herkansingen.
//   node --test test/aanvraag.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';

import { maakFacturenApp, maakBasicAuth } from '../service/facturen/server.mjs';
import { maakPortaal } from '../service/facturen/portaal.mjs';
import { maakMailApp } from '../service/facturen/mail.mjs';
import { maakAanvraagApp, MAX_BESTANDEN } from '../service/facturen/aanvraag.mjs';
import { maakAanvraagOpslag } from '../service/facturen/lib/aanvraag-opslag.mjs';
import { maakAanvraagKoppeling } from '../service/facturen/lib/aanvraag-koppeling.mjs';
import { MAX_POGINGEN_AUTH, maakWachtrij, wachtMinuten } from '../service/facturen/lib/aanvraag-doorsturen.mjs';
import { naarContract, samenvatting, valideer, verdeelBijlagen } from '../service/facturen/lib/aanvraag-velden.mjs';
import { boundaryUit, leesMultipart, typeUitInhoud } from '../service/facturen/lib/multipart.mjs';
import { maakSorteerOpslag } from '../service/facturen/lib/sorteer-opslag.mjs';
import { maakSorteerder } from '../service/facturen/lib/sorteren.mjs';
import { maakWebhook } from '../service/facturen/lib/webhook.mjs';
import { openDatabase } from '../service/facturen/lib/db.mjs';
import * as instellingen from '../service/facturen/lib/instellingen.mjs';
import { GEHEIM } from './portaal-hulp.mjs';
import { nepMailbox } from './mail-hulp.mjs';
import { nepGraph, ruimOp, tijdelijkeOpslag } from './facturen-hulp.mjs';

const ORIGIN = 'https://dekoningtegelwerken.nl';
const SLEUTEL = 'a'.repeat(64);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const PDF = Buffer.from('%PDF-1.4 test ' + 'x'.repeat(100));

// Nagebootst Offerteknop: POST /api/aanvragen/website met Bearer-sleutel.
async function nepOfferteknop() {
  const stand = { aanvragen: [], antwoord: null, auth: [] };
  const server = http.createServer((req, res) => {
    const delen = [];
    req.on('data', (d) => delen.push(d));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(delen).toString('utf8') || '{}');
      stand.auth.push(req.headers.authorization || '');
      const antwoord = (status, data, koppen = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...koppen }); res.end(JSON.stringify(data)); };
      if (req.headers.authorization !== 'Bearer ' + SLEUTEL) return antwoord(401, { error: 'Onbekende sleutel.' });
      if (req.url !== '/api/aanvragen/website') return antwoord(404, { error: 'onbekend' });
      if (stand.antwoord) { const a = stand.antwoord; stand.antwoord = null; return antwoord(a.status, a.data, a.koppen); }
      const bestaand = stand.aanvragen.find((a) => a.referentie === body.referentie);
      if (bestaand) return antwoord(200, { ok: true, offerte_id: bestaand.id, nummer_str: `CONCEPT-${bestaand.id}`, status: 'nieuwe_aanvraag', klant_id: 1, bestaand: true, bijlagen: [] });
      const id = 100 + stand.aanvragen.length;
      stand.aanvragen.push({ id, referentie: body.referentie, body });
      return antwoord(201, { ok: true, offerte_id: id, nummer_str: `CONCEPT-${id}`, status: 'nieuwe_aanvraag', klant_id: 1, bestaand: false, bijlagen: (body.bijlagen || []).map((b) => ({ naam: b.naam, opgenomen: true, reden: null })) });
    });
  });
  await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
  return { stand, url: `http://127.0.0.1:${server.address().port}/api/aanvragen/website`, stop: () => new Promise((r) => server.close(r)) };
}

const tijd = { nu: Date.now() };
const nu = () => tijd.nu;

async function bouw({ sleutel = SLEUTEL, mailBeschikbaar = true } = {}) {
  const nep = await nepOfferteknop();
  const { opslag, pdfMap, map } = tijdelijkeOpslag();
  const sorteerOpslag = maakSorteerOpslag(opslag.db);
  const aanvraagOpslag = maakAanvraagOpslag(opslag.db);
  const mail = nepMailbox();
  mail.beschikbaar = mailBeschikbaar;
  mail.verstuurd = [];
  mail.faal = false;
  mail.verstuurMail = async (o) => { if (mail.faal) throw new Error('Graph is stuk'); mail.verstuurd.push(o); return { verzonden: true }; };
  const koppeling = maakAanvraagKoppeling({ url: nep.url, sleutel });
  const logboek = [];
  const log = (niveau, bericht) => { logboek.push([niveau, bericht]); opslag.log(niveau, bericht); };
  const wachtrij = maakWachtrij({ aanvraagOpslag, koppeling, mail, mailNaar: 'info@dekoningtegelwerken.nl', log, nu });
  const aanvraag = maakAanvraagApp({ aanvraagOpslag, wachtrij: null, bestandenMap: path.join(map, 'aanvragen'), origins: [ORIGIN], log, nu, rate: { aantal: 3, vensterMs: 3600 * 1000 }, dagLimiet: 50 });

  const facturen = maakFacturenApp({ opslag, graph: nepGraph(), pdfMap, basisPad: '/facturen', nu: () => '2026-10-11' });
  const sorteerder = maakSorteerder({ sorteerOpslag, mail, classificeerder: null, instellingenLezer: () => instellingen.lees(opslag) });
  const webhook = maakWebhook({ mail, sorteerOpslag, sorteerder, actief: false });
  const mailApp = maakMailApp({ opslag, sorteerOpslag, sorteerder, webhook, mail, basisPad: '/mail' });
  const auth = { modus: 'basic', basic: maakBasicAuth({ gebruiker: 'bob', wachtwoord: 'test' }), geheim: GEHEIM };
  const { server } = maakPortaal({ opslag, sorteerOpslag, facturen, mailApp, webhook, auth, aanvraag, offertesUrl: 'https://de-koning-tegelwerken.offerteknop.nl/offertes/' });
  await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
  return { nep, server, adres: `http://127.0.0.1:${server.address().port}`, opslag, aanvraagOpslag, mail, koppeling, wachtrij, logboek, map };
}

// Een volledige, geldige aanvraag als FormData; velden en bestanden zijn per test te overschrijven.
function formulier({ velden = {}, bestanden = [], geladen = tijd.nu - 10000 } = {}) {
  const fd = new FormData();
  const basis = {
    ruimte: ['badkamer', 'toilet'], 'extra-badkamer': ['Inloopdouche', 'Nis'], 'm2-badkamer': '8,5', 'wand-badkamer': '31',
    'onbekend-toilet': 'ja', tegels: 'ja', formaat: ['60 × 120 cm'], naam: 'Test Persoon', telefoon: '06 12345678',
    email: 'Test@Example.nl', postcode: '1971ra', periode: 'Zo snel mogelijk', toelichting: 'Graag voor de winter.', privacy: 'ja', website: '', t: String(geladen),
  };
  for (const [k, v] of Object.entries({ ...basis, ...velden })) {
    if (v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  }
  for (const [veld, naam, inhoud, type] of bestanden) fd.append(veld, new Blob([inhoud], { type }), naam);
  return fd;
}

let p;
const stuur = (fd, koppen = {}) => fetch(p.adres + '/api/aanvraag/indienen', { method: 'POST', body: fd, headers: { origin: ORIGIN, ...koppen } });

before(async () => { p = await bouw(); });
after(async () => { await new Promise((r) => p.server.close(r)); await p.nep.stop(); ruimOp(); });

test('multipart-lezer: velden en bestanden, boundary met aanhalingstekens, type uit de inhoud', () => {
  assert.equal(boundaryUit('multipart/form-data; boundary="abc 123"'), 'abc 123');
  assert.equal(boundaryUit('multipart/form-data; charset=utf-8; boundary=xyz'), 'xyz');
  assert.equal(boundaryUit('application/json'), null);
  const b = 'grens';
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="naam"\r\n\r\nJan\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="ruimte"\r\n\r\nbadkamer\r\n--${b}\r\nContent-Disposition: form-data; name="ruimte"\r\n\r\nvloer\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="fotos"; filename="a\\"b.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), JPEG, Buffer.from('\r\n'),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="plattegrond"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n`),
    Buffer.from(`--${b}--\r\n`),
  ]);
  const uit = leesMultipart(body, b);
  assert.deepEqual(uit.velden.get('naam'), ['Jan']);
  assert.deepEqual(uit.velden.get('ruimte'), ['badkamer', 'vloer']);
  assert.equal(uit.bestanden.length, 1, 'een leeg bestandsveld telt niet');
  assert.equal(uit.bestanden[0].naam, 'a"b.jpg');
  assert.equal(uit.bestanden[0].inhoud.length, JPEG.length);
  assert.equal(typeUitInhoud(uit.bestanden[0].inhoud), 'image/jpeg');
  assert.equal(typeUitInhoud(PDF), 'application/pdf');
  assert.equal(typeUitInhoud(Buffer.from('<html>' + 'x'.repeat(20))), null);
  assert.throws(() => leesMultipart(Buffer.from('niets'), b), /boundary/);
});

test('valideer: dezelfde regels als de wizard; samenvatting zoals De Koning hem wil lezen', () => {
  const ok = valideer({ ruimte: ['badkamer', 'anders'], anders: 'Een trap', 'm2-badkamer': '8,5', 'wand-badkamer': '31', 'extra-badkamer': ['Nis'], tegels: 'orienteren', formaat: ['Visgraat'], naam: ' Jan de Tester ', email: 'JAN@Example.NL', postcode: '1971ra', privacy: 'ja' });
  assert.equal(ok.fout, undefined);
  assert.deepEqual(ok.velden.ruimtes[0], { soort: 'badkamer', onbekend: false, m2_vloer: 8.5, m2_wand: 31, extra: ['Nis'] });
  assert.equal(ok.velden.anders, 'Een trap');
  assert.equal(ok.velden.email, 'jan@example.nl');
  assert.equal(ok.velden.postcode, '1971 RA');
  assert.equal(ok.velden.naam, 'Jan de Tester');
  const sv = samenvatting(ok.velden, [{ soort: 'fotos' }, { soort: 'fotos' }, { soort: 'plattegrond' }]);
  assert.equal(sv.titel, 'Nieuwe aanvraag – Badkamer, Anders, 1971 RA');
  assert.match(sv.tekst, /Badkamer: vloer ±8,5 m², wanden ±31 m² · Nis/);
  assert.match(sv.tekst, /Tegels: Visgraat · nog aan het oriënteren/);
  assert.match(sv.tekst, /Bijlagen: 2 foto's \+ plattegrond/);
  assert.doesNotMatch(sv.tekst, /Telefoon/);

  const fout = (invoer) => valideer({ ruimte: ['vloer'], 'm2-vloer': '20', tegels: 'nee', naam: 'Jan', telefoon: '0612345678', postcode: '1234 AB', privacy: 'ja', ...invoer });
  assert.deepEqual(fout({ ruimte: [] }), { fout: 'Kies minstens één ruimte.', veld: 'ruimte' });
  assert.equal(fout({ ruimte: ['anders'] }).veld, 'anders');
  assert.equal(fout({ 'm2-vloer': '' }).veld, 'm2-vloer');
  assert.equal(fout({ 'm2-vloer': 'veel' }).veld, 'm2-vloer');
  assert.equal(fout({ 'm2-vloer': '', 'onbekend-vloer': 'ja' }).fout, undefined);
  assert.equal(fout({ tegels: 'misschien' }).veld, 'tegels');
  assert.equal(fout({ naam: 'J' }).veld, 'naam');
  assert.equal(fout({ telefoon: '', email: '' }).veld, 'telefoon');
  assert.equal(fout({ telefoon: '06 123' }).veld, 'telefoon');
  assert.equal(fout({ telefoon: '', email: 'geen adres' }).veld, 'email');
  assert.equal(fout({ postcode: '12345' }).veld, 'postcode');
  assert.equal(fout({ privacy: '' }).veld, 'privacy');
  assert.equal(fout({ 'wand-vloer': '10' }).velden.ruimtes[0].m2_wand, null, 'een vloer heeft geen wanden');
});

test('verdeelBijlagen en naarContract: grenzen van Offerteknop, volgorde, rest in de toelichting', () => {
  const groot = { soort: 'plattegrond', naam: 'p.pdf', type: 'application/pdf', grootte: 9 * 1024 * 1024 };
  const fotos = Array.from({ length: 11 }, (_, i) => ({ soort: 'fotos', naam: `f${i}.jpg`, type: 'image/jpeg', grootte: 1000 }));
  const { mee, niet } = verdeelBijlagen([groot, { soort: 'tegelfoto', naam: 't.jpg', type: 'image/jpeg', grootte: 10 }, ...fotos]);
  assert.equal(mee.length, 10);
  assert.equal(mee[0].naam, 't.jpg', "de tegelfoto eerst, dan de foto's");
  assert.deepEqual(mee.slice(1).map((b) => b.naam), Array.from({ length: 9 }, (_, i) => `f${i}.jpg`));
  assert.deepEqual(niet.map((b) => [b.naam, b.reden]), [['p.pdf', 'groter dan 8 MB'], ['f9.jpg', 'meer dan 10 bijlagen'], ['f10.jpg', 'meer dan 10 bijlagen']]);
  const aanvraag = { referentie: 'ref-1', tijd: '2026-10-11T08:00:00Z', velden: valideer({ ruimte: ['badkamer'], 'm2-badkamer': '8', tegels: 'ja', formaat: ['60 × 60 cm'], naam: 'Jan', telefoon: '0612345678', postcode: '1971 RA', privacy: 'ja', periode: 'november' }).velden };
  const c = naarContract(aanvraag, { bijlagen: [{ ...mee[0], inhoud_b64: 'AAAA' }], niet });
  assert.equal(c.referentie, 'ref-1');
  assert.equal(c.honeypot, '');
  assert.deepEqual(c.klant, { naam: 'Jan', postcode: '1971 RA', type: 'particulier', telefoon: '0612345678' });
  assert.deepEqual(c.project.ruimtes, [{ soort: 'badkamer', onbekend: false, extra: [], m2_vloer: 8 }]);
  assert.deepEqual(c.project.tegels, { status: 'ja', formaten: ['60 × 60 cm'] });
  assert.equal(c.project.periode, 'november');
  assert.match(c.project.toelichting, /^Niet meegestuurd: p\.pdf \(plattegrond, groter dan 8 MB\); f9\.jpg \(foto, meer dan 10 bijlagen\); f10\.jpg \(foto, meer dan 10 bijlagen\)$/);
  assert.deepEqual(c.bijlagen, [{ soort: 'tegelfoto', naam: 't.jpg', type: 'image/jpeg', inhoud_b64: 'AAAA' }]);
  assert.equal('email' in c.klant, false, 'lege velden gaan niet mee');
});

test('indienen: herkomst, honeypot, invultijd, veldfouten en bestandscontrole', async () => {
  const geen = await fetch(p.adres + '/api/aanvraag/indienen', { method: 'POST', body: formulier() });
  assert.equal(geen.status, 403);
  assert.equal((await stuur(formulier(), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(p.adres + '/api/aanvraag/indienen', { method: 'GET', headers: { origin: ORIGIN } })).status, 405);
  assert.equal((await fetch(p.adres + '/api/aanvraag/indienen', { method: 'POST', body: '{}', headers: { origin: ORIGIN, 'content-type': 'application/json' } })).status, 415);
  assert.equal((await fetch(p.adres + '/api/aanvraag/anders', { method: 'POST', headers: { origin: ORIGIN } })).status, 404);

  const honing = await stuur(formulier({ velden: { website: 'http://spam' } }));
  assert.equal(honing.status, 200);
  assert.deepEqual(await honing.json(), { ok: true });
  assert.equal(p.aanvraagOpslag.stand().wacht, 0, 'honeypot: niets opgeslagen');

  const snel = await stuur(formulier({ geladen: tijd.nu - 500 }));
  assert.equal(snel.status, 400);
  assert.match((await snel.json()).error, /heel snel/);
  assert.equal((await stuur(formulier({ velden: { t: '' } }))).status, 400);

  const veld = await stuur(formulier({ velden: { postcode: 'abc' } }));
  assert.equal(veld.status, 400);
  assert.deepEqual(await veld.json(), { error: 'Vul een postcode in zoals 1971 RA.', veld: 'postcode' });

  const links = await stuur(formulier({ velden: { toelichting: 'zie http://a.nl en http://b.nl en http://c.nl' } }));
  assert.equal(links.status, 400);
  assert.equal((await links.json()).veld, 'toelichting');

  const nepFoto = await stuur(formulier({ bestanden: [['fotos', 'x.jpg', Buffer.from('<html>' + 'x'.repeat(30)), 'image/jpeg']] }));
  assert.equal(nepFoto.status, 400);
  assert.match((await nepFoto.json()).error, /geen foto of PDF/);
  const pdfAlsFoto = await stuur(formulier({ bestanden: [['fotos', 'x.jpg', PDF, 'image/jpeg']] }));
  assert.equal(pdfAlsFoto.status, 400);
  const teVeel = await stuur(formulier({ bestanden: Array.from({ length: MAX_BESTANDEN + 1 }, (_, i) => ['fotos', `f${i}.jpg`, JPEG, 'image/jpeg']) }));
  assert.equal(teVeel.status, 400);
  assert.equal(p.aanvraagOpslag.stand().wacht, 0, 'niets opgeslagen bij een fout');
  assert.equal(existsSync(path.join(p.map, 'aanvragen')) ? readdirSync(path.join(p.map, 'aanvragen')).length : 0, 0, 'geen bestandsmap achtergebleven');
});

test('indienen: een geldige aanvraag wordt opgeslagen met bestanden; de wachtrij mailt en stuurt door; de bezoeker krijgt alleen ok', async () => {
  const r = await stuur(formulier({ bestanden: [['fotos', 'Vloer.JPG', JPEG, 'image/jpeg'], ['tegelfoto', 'tegel.jpg', JPEG, 'image/jpeg'], ['plattegrond', 'plan.pdf', PDF, 'application/pdf']] }));
  assert.equal(r.status, 200);
  const uit = await r.json();
  assert.equal(uit.ok, true);
  assert.match(uit.referentie, /^[0-9a-f-]{36}$/);
  const a = p.aanvraagOpslag.bijReferentie(uit.referentie);
  assert.equal(a.status, 'nieuw');
  assert.equal(a.velden.naam, 'Test Persoon');
  assert.equal(a.velden.email, 'test@example.nl');
  assert.deepEqual(a.bestanden.map((b) => [b.soort, b.naam, b.type]), [['fotos', 'Vloer.jpg', 'image/jpeg'], ['tegelfoto', 'tegel.jpg', 'image/jpeg'], ['plattegrond', 'plan.pdf', 'application/pdf']]);
  assert.ok(a.bestandsmap.endsWith(uit.referentie));
  assert.deepEqual(readdirSync(a.bestandsmap).sort(), ['01-foto.jpg', '02-tegelfoto.jpg', '03-plattegrond.pdf']);
  assert.equal(p.aanvraagOpslag.stand().wacht, 1);
  const log = p.logboek.map(([, b]) => b).join('\n');
  assert.doesNotMatch(log, /Test Persoon|example\.nl|1971/, 'logregels zonder inhoud');

  const ronde = await p.wachtrij.ronde();
  assert.equal(ronde.verwerkt, 1);
  const na = p.aanvraagOpslag.aanvraag(a.id);
  assert.equal(na.mail_status, 'verzonden');
  assert.equal(na.koppeling_status, 'klaar');
  assert.equal(na.status, 'klaar');
  assert.equal(na.offerte_id, 100);
  assert.equal(na.offerte_nummer, 'CONCEPT-100');
  /* de mail: naar de mailbox zelf, Reply-To de aanvrager, samenvatting en bijlagen */
  assert.equal(p.mail.verstuurd.length, 1);
  const m = p.mail.verstuurd[0];
  assert.equal(m.aan, 'info@dekoningtegelwerken.nl');
  assert.equal(m.replyTo, 'test@example.nl');
  assert.equal(m.onderwerp, 'Nieuwe aanvraag – Badkamer, Toilet, 1971 RA');
  assert.match(m.tekst, /Badkamer: vloer ±8,5 m², wanden ±31 m² · Inloopdouche, Nis/);
  assert.match(m.tekst, /Toilet: oppervlak nog onbekend/);
  assert.match(m.tekst, /Tegels: 60 × 120 cm · al aangeschaft · foto van de tegel/);
  assert.match(m.tekst, /Bijlagen: 1 foto \+ plattegrond/);
  assert.match(m.tekst, /Telefoon: 06 12345678/);
  assert.match(m.tekst, new RegExp(`Aanvraag ${uit.referentie}`));
  assert.deepEqual(m.bijlagen.map((b) => b.naam), ['tegel.jpg', 'plan.pdf', 'Vloer.jpg']);
  assert.equal(Buffer.from(m.bijlagen[1].inhoud_b64, 'base64').toString('utf8').slice(0, 5), '%PDF-');
  /* Offerteknop: het contract, met Bearer-sleutel */
  assert.equal(p.nep.stand.aanvragen.length, 1);
  const body = p.nep.stand.aanvragen[0].body;
  assert.equal(body.referentie, uit.referentie);
  assert.equal(body.klant.email, 'test@example.nl');
  assert.deepEqual(body.project.ruimtes[1], { soort: 'toilet', onbekend: true, extra: [] });
  assert.deepEqual(body.bijlagen.map((b) => [b.soort, b.naam, b.type]), [['tegelfoto', 'tegel.jpg', 'image/jpeg'], ['plattegrond', 'plan.pdf', 'application/pdf'], ['foto', 'Vloer.jpg', 'image/jpeg']]);
  assert.equal(body.honeypot, '');
  assert.equal(p.nep.stand.auth[0], 'Bearer ' + SLEUTEL);
  assert.doesNotMatch(p.logboek.map(([, b]) => b).join('\n'), new RegExp(SLEUTEL), 'de sleutel komt nergens in een logregel');
  /* het dashboard meldt niets meer */
  assert.equal(p.aanvraagOpslag.stand().wacht, 0);
  /* een tweede ronde doet niets */
  assert.equal((await p.wachtrij.ronde()).verwerkt, 0);
});

test('wachtrij: mislukte mail en Offerteknop komen terug met oplopende wachttijd; 429 respecteert Retry-After; 400 stopt; 401 stopt na een paar keer', async () => {
  assert.deepEqual([1, 2, 3, 4, 7, 8].map(wachtMinuten), [1, 2, 4, 8, 60, 60]);
  p.mail.faal = true;
  p.nep.stand.antwoord = { status: 500, data: { error: 'kapot' } };
  const r = await stuur(formulier());
  assert.equal(r.status, 200);
  const { referentie } = await r.json();
  const id = p.aanvraagOpslag.bijReferentie(referentie).id;
  await p.wachtrij.ronde();
  let a = p.aanvraagOpslag.aanvraag(id);
  assert.equal(a.mail_status, 'wacht');
  assert.equal(a.koppeling_status, 'wacht');
  assert.equal(a.pogingen, 1);
  assert.match(a.mail_fout, /Graph is stuk/);
  assert.match(a.koppeling_fout, /500: kapot/);
  assert.equal(a.volgende_poging, new Date(tijd.nu + 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  assert.equal((await p.wachtrij.ronde()).verwerkt, 0, 'nog niet aan de beurt');
  /* een minuut later: de mail lukt, Offerteknop zegt 429 met Retry-After */
  tijd.nu += 61 * 1000;
  p.mail.faal = false;
  p.nep.stand.antwoord = { status: 429, data: { error: 'rustig' }, koppen: { 'retry-after': '120' } };
  await p.wachtrij.ronde();
  a = p.aanvraagOpslag.aanvraag(id);
  assert.equal(a.mail_status, 'verzonden');
  assert.equal(a.koppeling_status, 'wacht');
  assert.equal(a.pogingen, 2);
  assert.equal(a.volgende_poging, new Date(tijd.nu + 120 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  /* daarna lukt het; dezelfde referentie, dus idempotent aan de kant van Offerteknop */
  tijd.nu += 121 * 1000;
  await p.wachtrij.ronde();
  a = p.aanvraagOpslag.aanvraag(id);
  assert.equal(a.koppeling_status, 'klaar');
  assert.equal(a.status, 'klaar');
  assert.equal(a.volgende_poging, null);
  assert.equal(p.nep.stand.aanvragen.filter((x) => x.referentie === referentie).length, 1);

  /* 400: niet opnieuw proberen, wel in het logboek */
  p.nep.stand.antwoord = { status: 400, data: { error: 'klant.naam is verplicht.', veld: 'klant.naam' } };
  const r2 = await stuur(formulier({ velden: { naam: 'Tweede Persoon' } }));
  const id2 = p.aanvraagOpslag.bijReferentie((await r2.json()).referentie).id;
  await p.wachtrij.ronde();
  a = p.aanvraagOpslag.aanvraag(id2);
  assert.equal(a.koppeling_status, 'gestopt');
  assert.equal(a.mail_status, 'verzonden');
  assert.equal(a.status, 'gestopt');
  assert.match(a.koppeling_fout, /400: klant\.naam is verplicht\. \(veld klant\.naam\)/);
  assert.equal(p.aanvraagOpslag.stand().gestopt, 1);
  assert.ok(p.logboek.some(([n, b]) => n === 'error' && /weigert de aanvraag/.test(b)));
  const dashboard = await (await fetch(p.adres + '/', { headers: { authorization: 'Basic ' + Buffer.from('bob:test').toString('base64') } })).text();
  assert.match(dashboard, /<strong>1<\/strong> website-aanvraag niet doorgestuurd/);

  /* 401 (verkeerde sleutel): een paar keer met wachttijd, dan gestopt met een duidelijke melding */
  tijd.nu += 3601 * 1000; // de rate limit van dit "IP" is na drie aanvragen vol
  const verkeerd = maakAanvraagKoppeling({ url: p.nep.url, sleutel: 'b'.repeat(64) });
  const wachtrij2 = maakWachtrij({ aanvraagOpslag: p.aanvraagOpslag, koppeling: verkeerd, mail: p.mail, mailNaar: 'info@dekoningtegelwerken.nl', log: (n, b) => p.logboek.push([n, b]), nu });
  const r3 = await stuur(formulier({ velden: { naam: 'Derde Persoon' } }));
  const id3 = p.aanvraagOpslag.bijReferentie((await r3.json()).referentie).id;
  for (let i = 0; i < MAX_POGINGEN_AUTH; i++) {
    await wachtrij2.ronde();
    tijd.nu += 61 * 60 * 1000;
  }
  a = p.aanvraagOpslag.aanvraag(id3);
  assert.equal(a.koppeling_status, 'gestopt');
  assert.equal(a.pogingen, MAX_POGINGEN_AUTH);
  assert.match(a.koppeling_fout, /AANVRAAG_OFFERTEKNOP_SLEUTEL/);
  assert.equal(a.mail_status, 'verzonden', 'de mail ging bij de eerste ronde al');
});

test('zonder sleutel: aanvraag opgeslagen, mail gaat, doorsturen blijft wachten zonder fout; met sleutel later alsnog', async () => {
  const q = await bouw({ sleutel: '' });
  try {
    assert.equal(q.koppeling.beschikbaar, false);
    assert.deepEqual(q.koppeling.ontbreekt, ['AANVRAAG_OFFERTEKNOP_SLEUTEL']);
    const r = await fetch(q.adres + '/api/aanvraag/indienen', { method: 'POST', body: formulier(), headers: { origin: ORIGIN } });
    assert.equal(r.status, 200);
    const { referentie } = await r.json();
    assert.equal((await q.wachtrij.ronde()).verwerkt, 1);
    const a = q.aanvraagOpslag.bijReferentie(referentie);
    assert.equal(a.mail_status, 'verzonden');
    assert.equal(a.koppeling_status, 'wacht');
    assert.equal(a.pogingen, 0, 'een ontbrekende sleutel telt niet als mislukte poging');
    assert.equal(a.koppeling_fout, null);
    assert.equal((await q.wachtrij.ronde()).verwerkt, 0, 'niets meer te doen zolang de sleutel ontbreekt');
    assert.equal(q.aanvraagOpslag.stand().wacht, 1);
    /* de sleutel komt erbij (herstart van de dienst): dezelfde wachtrij, nieuwe koppeling */
    const later = maakWachtrij({ aanvraagOpslag: q.aanvraagOpslag, koppeling: maakAanvraagKoppeling({ url: q.nep.url, sleutel: SLEUTEL }), mail: q.mail, mailNaar: 'x@y.nl', nu });
    assert.equal((await later.ronde()).verwerkt, 1);
    assert.equal(q.aanvraagOpslag.bijReferentie(referentie).koppeling_status, 'klaar');
    assert.equal(q.mail.verstuurd.length, 1, 'de mail niet nog een keer');
  } finally {
    await new Promise((r) => q.server.close(r));
    await q.nep.stop();
  }
});

test('limieten: rate limit per IP en de daglimiet', async () => {
  const q = await bouw();
  try {
    const post = () => fetch(q.adres + '/api/aanvraag/indienen', { method: 'POST', body: formulier(), headers: { origin: ORIGIN } });
    for (let i = 0; i < 3; i++) assert.equal((await post()).status, 200);
    const vierde = await post();
    assert.equal(vierde.status, 429);
    assert.match((await vierde.json()).error, /over een uur/);
    tijd.nu += 3601 * 1000;
    assert.equal((await post()).status, 200, 'na een uur weer');
    /* daglimiet, via een andere "bezoeker" */
    const ander = () => fetch(q.adres + '/api/aanvraag/indienen', { method: 'POST', body: formulier(), headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.' + Math.floor(Math.random() * 250) } });
    let status = 200;
    for (let i = 0; i < 60 && status === 200; i++) status = (await ander()).status;
    assert.equal(status, 429);
    assert.ok(q.aanvraagOpslag.stand().wacht <= 50);
  } finally {
    await new Promise((r) => q.server.close(r));
    await q.nep.stop();
  }
});

test('schema: een database van versie 3 krijgt de wachtrij-kolommen erbij zonder rijen te verliezen', () => {
  const map = mkdtempSync(path.join(os.tmpdir(), 'dekoning-schema-'));
  try {
    const pad = path.join(map, 'oud.db');
    const oud = openDatabase(pad);
    oud.exec(`DROP TABLE aanvragen; CREATE TABLE aanvragen (id INTEGER PRIMARY KEY AUTOINCREMENT, tijd TEXT NOT NULL, bron TEXT NOT NULL, velden TEXT NOT NULL, bestanden TEXT, status TEXT NOT NULL DEFAULT 'nieuw', offerte_id INTEGER);
      INSERT INTO aanvragen (tijd, bron, velden) VALUES ('2026-10-10T10:00:00Z', 'website', '{}'); PRAGMA user_version = 3;`);
    oud.close();
    const nieuw = openDatabase(pad);
    assert.equal(nieuw.prepare('PRAGMA user_version').get().user_version, 4);
    const rij = nieuw.prepare('SELECT * FROM aanvragen').get();
    assert.equal(rij.bron, 'website');
    assert.equal(rij.mail_status, 'wacht');
    assert.equal(rij.pogingen, 0);
    assert.equal(rij.referentie, null);
    const opslag = maakAanvraagOpslag(nieuw);
    assert.equal(opslag.stand().wacht, 1);
    nieuw.close();
  } finally {
    rmSync(map, { recursive: true, force: true });
  }
});
