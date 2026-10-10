// De koppeling met Offerteknop, met een nagebootst Offerteknop dat de HMAC
// controleert: de pagina Offertes en het bijwerken, de tegels op het
// dashboard, de webhook (/intern/offerteknop/webhook) met replay en de
// lokaal-controle, de mailrelay (/intern/mail/verstuur) met ontvangercheck
// en limiet, en "Maak offerte" bij een mail.
//   node --test test/offertes-koppeling.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

import { maakFacturenApp, maakBasicAuth } from '../service/facturen/server.mjs';
import { maakPortaal } from '../service/facturen/portaal.mjs';
import { maakMailApp } from '../service/facturen/mail.mjs';
import { maakOffertesApp } from '../service/facturen/offertes.mjs';
import { maakIntern } from '../service/facturen/intern.mjs';
import { maakOfferteknop, controleerHandtekening, maakKoppen, KOPPEN } from '../service/facturen/lib/offerteknop.mjs';
import { maakOfferteOpslag } from '../service/facturen/lib/offerte-opslag.mjs';
import { maakSorteerOpslag } from '../service/facturen/lib/sorteer-opslag.mjs';
import { maakSorteerder } from '../service/facturen/lib/sorteren.mjs';
import { maakWebhook } from '../service/facturen/lib/webhook.mjs';
import { parseerAanvraag, terugval } from '../service/facturen/lib/aanvraag.mjs';
import * as instellingen from '../service/facturen/lib/instellingen.mjs';
import { GEHEIM } from './portaal-hulp.mjs';
import { bericht, nepClassificeerder, nepMailbox } from './mail-hulp.mjs';
import { nepGraph, ruimOp, tijdelijkeOpslag } from './facturen-hulp.mjs';

const TENANT = 'de-koning-tegelwerken';
const SLEUTEL_IN = crypto.randomBytes(32).toString('hex');   // portaal -> Offerteknop
const SLEUTEL_UIT = crypto.randomBytes(32).toString('hex');  // Offerteknop -> portaal
const BEWERK = (id) => `https://de-koning-tegelwerken.offerteknop.nl/offertes/prijsboek-offerte.html?id=${id}`;

const offerte = (id, extra = {}) => ({
  id, nummer: `OFF-2026-000${id}`, nummer_intern: id, nummer_str: `OFF-2026-000${id}`, versie: 1, status: 'verstuurd', status_intern: 'offerte_verstuurd',
  gearchiveerd: false, klant_naam: `Klant ${id}`, klant_email: `klant${id}@voorbeeld.nl`, klant_telefoon: '', klanttype: 'particulier', projectadres: null,
  bedrag_excl_cent: 100000 * id, bedrag_incl_cent: 121000 * id, btw_pct: 21, datum: '2026-10-09', aangemaakt_op: '2026-10-09T10:00:00Z',
  gewijzigd_op: '2026-10-09T10:00:00Z', verstuurd_op: '2026-10-09T11:00:00Z', bekeken_op: null, beslist_op: null, geldig_tot: '2026-11-08',
  verlopen_op: null, ingetrokken_op: null, bron: 'handmatig', referentie: null, bewerk_url: BEWERK(id), ...extra,
});

// Nagebootst Offerteknop: controleert onze handtekening en bewaart wat binnenkomt.
async function nepOfferteknop() {
  const stand = { lijst: [offerte(1), offerte(2, { status: 'concept', status_intern: 'offerte_maken', verstuurd_op: null, nummer: null, nummer_str: 'CONCEPT-0002' })], concepten: [], ongeldig: 0 };
  const server = http.createServer((req, res) => {
    const delen = [];
    req.on('data', (d) => delen.push(d));
    req.on('end', () => {
      const body = Buffer.concat(delen);
      const uit = controleerHandtekening({ sleutel: SLEUTEL_IN, methode: req.method, pad: req.url, body, tijd: req.headers[KOPPEN.tijd], nonce: req.headers[KOPPEN.nonce], handtekening: req.headers[KOPPEN.handtekening] });
      const antwoord = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (uit.fout || req.headers[KOPPEN.tenant] !== TENANT) { stand.ongeldig += 1; return antwoord(401, { error: uit.fout || 'tenant' }); }
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/api/tenant/offertes') return antwoord(200, { tenant: TENANT, aantal: stand.lijst.length, offertes: stand.lijst });
      const een = url.pathname.match(/^\/api\/tenant\/offertes\/(\d+)$/);
      if (req.method === 'GET' && een) {
        const o = stand.lijst.find((x) => x.id === Number(een[1]));
        return o ? antwoord(200, o) : antwoord(404, { error: 'Offerte niet gevonden.' });
      }
      if (req.method === 'POST' && url.pathname === '/api/tenant/offertes/concept') {
        const b = JSON.parse(body.toString('utf8'));
        const bestaand = stand.concepten.find((c) => c.referentie === b.referentie);
        if (bestaand) return antwoord(200, { ...bestaand.offerte, bestaand: true, bijlagen: [] });
        const id = 70 + stand.concepten.length;
        const o = offerte(id, { status: 'concept', status_intern: 'offerte_maken', verstuurd_op: null, nummer: null, nummer_str: `CONCEPT-00${id}`, klant_naam: b.klant.naam, klant_email: b.klant.email || '', bron: b.bron, referentie: b.referentie || null });
        stand.concepten.push({ referentie: b.referentie, body: b, offerte: o });
        stand.lijst.push(o);
        return antwoord(201, { ...o, bestaand: false, bijlagen: (b.bijlagen || []).map((x) => ({ naam: x.naam, opgenomen: true })) });
      }
      antwoord(404, { error: 'onbekend' });
    });
  });
  await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
  return { stand, basis: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((r) => server.close(r)) };
}

async function bouw() {
  const nep = await nepOfferteknop();
  const { opslag, pdfMap } = tijdelijkeOpslag();
  const sorteerOpslag = maakSorteerOpslag(opslag.db);
  const offerteOpslag = maakOfferteOpslag(opslag.db);
  const ontvangen = new Date(Date.now() + 60 * 1000).toISOString();
  const mail = nepMailbox({
    rondes: [[bericht({ id: 'aanvraag1', adres: 'piet@voorbeeld.nl', naam: 'Piet Aanvrager', onderwerp: 'Offerte badkamer', ontvangen })]],
    inhoud: { 'aanvraag1@map:Offerteaanvragen': { tekst: 'Hallo, ik wil mijn badkamer laten betegelen, 8 m2 vloer en 30 m2 wand, 60x60. Bel me op 06 1234 5678. Groet, Piet, Dorpsstraat 1 IJmuiden', bijlagen: [] } },
  });
  mail.verstuurd = [];
  mail.bijlagen = async () => [{ naam: 'badkamer.jpg', type: 'image/jpeg', inhoud_b64: 'AAAA' }];
  mail.verstuurMail = async (o) => { mail.verstuurd.push(o); return { verzonden: true }; };
  mail.webhook = { async maak(o) { return { id: 'sub-1', verlooptOp: o.verlooptOp }; }, async verleng() {}, async verwijder() {} };

  const facturen = maakFacturenApp({ opslag, graph: nepGraph(), pdfMap, basisPad: '/facturen', nu: () => '2026-10-10' });
  const sorteerder = maakSorteerder({ sorteerOpslag, mail, classificeerder: nepClassificeerder({ map: 'Offerteaanvragen', zekerheid: 0.95, reden: 'aanvraag' }), instellingenLezer: () => instellingen.lees(opslag) });
  const webhook = maakWebhook({ mail, sorteerOpslag, sorteerder, geheim: 'x'.repeat(40), notificatieUrl: '', actief: false });
  const offerteknop = maakOfferteknop({ baseUrl: nep.basis, tenant: TENANT, sleutelIn: SLEUTEL_IN, sleutelUit: SLEUTEL_UIT });
  const aanvraagLezer = { beschikbaar: true, aanroepen: [], async lees(invoer) { this.aanroepen.push(invoer); return { velden: { ...terugval(invoer), naam: 'Piet Aanvrager', telefoon: '06 1234 5678', adres: 'Dorpsstraat 1', postcode_plaats: 'IJmuiden', omschrijving: 'Badkamer: 8 m2 vloer, 30 m2 wand, 60x60.' }, bron: 'nep' }; } };
  const offertes = maakOffertesApp({ opslag, offerteOpslag, offerteknop, mail, aanvraagLezer, basisPad: '/offertes' });
  const intern = maakIntern({ offerteOpslag, offerteknop, mail, limiet: { uur: 2, dag: 100 }, log: (n, b) => opslag.log(n, b) });
  const mailApp = maakMailApp({ opslag, sorteerOpslag, sorteerder, webhook, mail, classificeerder: nepClassificeerder(), offertes, basisPad: '/mail' });
  const auth = { modus: 'basic', basic: maakBasicAuth({ gebruiker: 'bob', wachtwoord: 'test-wachtwoord' }), geheim: GEHEIM };
  const { server } = maakPortaal({ opslag, sorteerOpslag, facturen, mailApp, webhook, auth, offertes, intern, offertesUrl: 'https://de-koning-tegelwerken.offerteknop.nl/offertes/' });
  await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
  const adres = `http://127.0.0.1:${server.address().port}`;
  await sorteerder.draai();
  await sorteerder.draai();
  return { nep, server, adres, opslag, offerteOpslag, sorteerOpslag, mail, offertes, aanvraagLezer };
}

const BASIC = 'Basic ' + Buffer.from('bob:test-wachtwoord').toString('base64');
const csrfUit = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
let p;
const haal = (pad, opties = {}) => fetch(p.adres + pad, { redirect: 'manual', ...opties, headers: { authorization: BASIC, ...(opties.headers || {}) } });
async function post(pad, velden = {}) {
  const pagina = await (await haal('/offertes/')).text();
  const body = new URLSearchParams({ ...velden, _csrf: csrfUit(pagina) });
  return haal(pad, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' } });
}
// Een ondertekend verzoek zoals Offerteknop het stuurt.
function internVerzoek(pad, body, { sleutel = SLEUTEL_UIT, extraKoppen = {}, nu = Date.now() } = {}) {
  const ruw = Buffer.from(JSON.stringify(body));
  const koppen = maakKoppen({ sleutel, tenant: TENANT, methode: 'POST', pad, body: ruw, nu });
  return fetch(p.adres + pad, { method: 'POST', body: ruw, headers: { ...koppen, 'content-type': 'application/json', ...extraKoppen } });
}

before(async () => { p = await bouw(); });
after(async () => { await new Promise((r) => p.server.close(r)); await p.nep.stop(); ruimOp(); });

test('zonder login is /offertes/ dicht; de pagina is leeg tot er is bijgewerkt', async () => {
  const dicht = await fetch(p.adres + '/offertes/');
  assert.equal(dicht.status, 401);
  const leeg = await haal('/offertes/');
  assert.equal(leeg.status, 200);
  const html = await leeg.text();
  assert.match(html, /0 offertes/);
  assert.match(html, /nog niet opgehaald/);
  assert.match(html, /href="\/offertes\/"[^>]*aria-current="page"/, 'Offertes in het hoofdmenu');
});

test('bijwerken haalt de lijst ondertekend op; filters en zoeken werken; rijen linken naar Offerteknop', async () => {
  const r = await post('/offertes/sync');
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/offertes/?m=bijgewerkt');
  assert.equal(p.nep.stand.ongeldig, 0);
  const html = await (await haal('/offertes/?filter=alle')).text();
  assert.match(html, /2 offertes/);
  assert.match(html, /OFF-2026-0001/);
  assert.match(html, /CONCEPT-0002/);
  assert.ok(html.includes(`href="${BEWERK(1)}"`), 'rij linkt naar de editor in Offerteknop');
  const wacht = await (await haal('/offertes/?filter=wacht')).text();
  assert.match(wacht, /1 offerte\b/);
  assert.match(wacht, /OFF-2026-0001/);
  assert.doesNotMatch(wacht, /CONCEPT-0002/);
  const zoek = await (await haal('/offertes/?filter=alle&zoek=klant+2')).text();
  assert.match(zoek, /1 offerte\b/);
  assert.match(zoek, /Klant 2/);
  assert.equal(p.offerteOpslag.offerte(1).status, 'verstuurd');
});

test('het dashboard toont de tegels voor offertes', async () => {
  const html = await (await haal('/')).text();
  assert.match(html, /<h2 id="kop-offertes">Offertes<\/h2>/);
  assert.match(html, /<strong>1<\/strong> concept</);
  assert.match(html, /<strong>1<\/strong> wacht op akkoord/);
  assert.match(html, /<strong>0<\/strong> geaccepteerd deze maand/);
});

test('webhook: ondertekend door Offerteknop werkt de spiegel bij; replay, dubbele gebeurtenis, fout en via nginx worden geweigerd', async () => {
  const gebeurtenis = { id: 'evt-1', gebeurtenis: 'geaccepteerd', tijd: new Date().toISOString(), tenant: TENANT, offerte: offerte(1, { status: 'geaccepteerd', status_intern: 'uitvoering_plannen', beslist_op: '2026-10-10T12:00:00Z' }) };
  const ok = await internVerzoek('/intern/offerteknop/webhook', gebeurtenis);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.equal(p.offerteOpslag.offerte(1).status, 'geaccepteerd');
  /* dezelfde gebeurtenis nog eens (nieuwe handtekening): herkend, niets dubbel */
  const nogmaals = await internVerzoek('/intern/offerteknop/webhook', gebeurtenis);
  assert.equal(nogmaals.status, 200);
  assert.equal((await nogmaals.json()).herhaald, true);
  /* verkeerde sleutel, oud verzoek, via nginx */
  assert.equal((await internVerzoek('/intern/offerteknop/webhook', gebeurtenis, { sleutel: SLEUTEL_IN })).status, 401);
  assert.equal((await internVerzoek('/intern/offerteknop/webhook', gebeurtenis, { nu: Date.now() - 400 * 1000 })).status, 401);
  assert.equal((await internVerzoek('/intern/offerteknop/webhook', gebeurtenis, { extraKoppen: { 'x-forwarded-for': '203.0.113.9' } })).status, 403);
  /* replay: exact hetzelfde ondertekende verzoek */
  const ruw = Buffer.from(JSON.stringify({ ...gebeurtenis, id: 'evt-2' }));
  const koppen = maakKoppen({ sleutel: SLEUTEL_UIT, tenant: TENANT, methode: 'POST', pad: '/intern/offerteknop/webhook', body: ruw });
  const stuur = () => fetch(p.adres + '/intern/offerteknop/webhook', { method: 'POST', body: ruw, headers: { ...koppen, 'content-type': 'application/json' } });
  assert.equal((await stuur()).status, 200);
  assert.equal((await stuur()).status, 409);
  /* geen login nodig, maar ook geen toegang tot de rest */
  assert.equal((await fetch(p.adres + '/intern/onbekend', { method: 'POST' })).status, 401);
  const dashboard = await (await haal('/')).text();
  assert.match(dashboard, /<strong>1<\/strong> geaccepteerd deze maand/);
  assert.match(dashboard, /1\.210,00/);
});

test('mailrelay: alleen naar het klantadres van de offerte, met bijlage, vanuit de mailbox; vrije relay en te veel worden geweigerd', async () => {
  const mail = { tenant: TENANT, gerelateerd_type: 'offerte', gerelateerd_id: 1, aan: 'klant1@voorbeeld.nl', onderwerp: 'Offerte OFF-2026-0001', html: '<p>Hallo</p>', tekst: 'Hallo', reply_to: null, bijlagen: [{ naam: 'Offerte.pdf', type: 'application/pdf', inhoud_b64: Buffer.from('%PDF-1.4').toString('base64') }] };
  const ok = await internVerzoek('/intern/mail/verstuur', mail);
  const okTekst = await ok.text();
  assert.equal(ok.status, 200, okTekst);
  assert.equal(JSON.parse(okTekst).verzonden, true);
  assert.equal(p.mail.verstuurd.length, 1);
  assert.equal(p.mail.verstuurd[0].aan, 'klant1@voorbeeld.nl');
  assert.equal(p.mail.verstuurd[0].bijlagen[0].naam, 'Offerte.pdf');
  assert.equal(p.mail.verstuurd[0].html, '<p>Hallo</p>');
  /* een ander adres dan de klant van die offerte */
  const vreemd = await internVerzoek('/intern/mail/verstuur', { ...mail, aan: 'iemand@anders.nl' });
  assert.equal(vreemd.status, 403);
  assert.match((await vreemd.json()).error, /klantadres/);
  /* zonder offerte: alleen naar de mailbox zelf */
  assert.equal((await internVerzoek('/intern/mail/verstuur', { ...mail, gerelateerd_type: null, gerelateerd_id: null })).status, 403);
  const eigen = await internVerzoek('/intern/mail/verstuur', { ...mail, gerelateerd_type: null, gerelateerd_id: null, aan: 'info@dekoningtegelwerken.nl' });
  assert.equal(eigen.status, 200);
  /* limiet: twee per uur in deze test */
  const derde = await internVerzoek('/intern/mail/verstuur', mail);
  assert.equal(derde.status, 429);
  assert.equal(p.mail.verstuurd.length, 2);
  const log = p.offerteOpslag.relayLijst();
  assert.equal(log.filter((r) => r.status === 'verzonden').length, 2);
  assert.equal(log.filter((r) => r.status === 'geweigerd').length, 3);
  /* te grote bijlagen */
  const groot = await internVerzoek('/intern/mail/verstuur', { ...mail, bijlagen: [{ naam: 'x.pdf', type: 'application/pdf', inhoud_b64: 'A'.repeat(5 * 1024 * 1024) }] });
  assert.equal(groot.status, 429, 'de limiet gaat voor');
});

test('Maak offerte bij een mail in Offerteaanvragen: concept met klantgegevens en foto, daarna door naar de editor; een tweede klik opent hetzelfde', async () => {
  const log = p.sorteerOpslag.logLijst({ map: 'Offerteaanvragen' });
  assert.equal(log.length, 1);
  const regel = log[0];
  const pagina = await (await haal('/mail/')).text();
  assert.match(pagina, new RegExp(`action="/mail/log/${regel.id}/offerte"`), 'knop Maak offerte');
  const r = await post(`/mail/log/${regel.id}/offerte`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), BEWERK(70));
  assert.equal(p.nep.stand.concepten.length, 1);
  const body = p.nep.stand.concepten[0].body;
  assert.equal(body.bron, 'portaal-mail');
  assert.equal(body.referentie, regel.internet_id);
  assert.equal(body.klant.naam, 'Piet Aanvrager');
  assert.equal(body.klant.email, 'piet@voorbeeld.nl');
  assert.equal(body.klant.telefoon, '06 1234 5678');
  assert.match(body.project.omschrijving, /^Onderwerp: Offerte badkamer\nBadkamer: 8 m2/);
  assert.equal(body.bijlagen.length, 1);
  assert.equal(body.bijlagen[0].naam, 'badkamer.jpg');
  assert.equal(p.aanvraagLezer.aanroepen[0].tekst.includes('badkamer laten betegelen'), true, 'de mailtekst ging naar de lezer');
  /* tweede klik: geen tweede concept, zelfde editor */
  const nogmaals = await post(`/mail/log/${regel.id}/offerte`);
  assert.equal(nogmaals.status, 303);
  assert.equal(nogmaals.headers.get('location'), BEWERK(70));
  assert.equal(p.nep.stand.concepten.length, 1);
  const daarna = await (await haal('/mail/')).text();
  assert.match(daarna, /Offerte openen/);
  assert.doesNotMatch(daarna, new RegExp(`action="/mail/log/${regel.id}/offerte"`));
  /* het concept staat in de lijst */
  const lijst = await (await haal('/offertes/?filter=concept')).text();
  assert.match(lijst, /Piet Aanvrager/);
  assert.match(lijst, /via mail/);
});

test('aanvraag lezen: JSON van het model wordt streng gelezen, terugval gebruikt de afzender', () => {
  const uit = parseerAanvraag('Hier: {"naam":"Jan","telefoon":"06-1","email":"JAN@Voorbeeld.nl","adres":"Laan 1","postcode_plaats":"1971 AB IJmuiden","omschrijving":"Vloer 20 m2"}');
  assert.equal(uit.email, 'jan@voorbeeld.nl');
  assert.equal(uit.naam, 'Jan');
  assert.equal(parseerAanvraag('{"email":"geen adres"}').email, '');
  assert.throws(() => parseerAanvraag('geen json'), /geen JSON/);
  const tv = terugval({ afzenderNaam: '', afzender: 'x@y.nl', tekst: 'tekst' });
  assert.equal(tv.naam, 'x');
  assert.equal(tv.email, 'x@y.nl');
  assert.equal(tv.omschrijving, 'tekst');
});
