// De schermen en de acties van het dashboard, via een echte http-server op
// een vrije poort. Geen koppelingen naar buiten: Graph is nagebootst, bunq en
// Claude zijn er niet.
//   node --test test/facturen-web.test.mjs

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { maakServer, uitEnv } from '../service/facturen/server.mjs';
import * as instellingen from '../service/facturen/lib/instellingen.mjs';
import { nepGraph, ruimOp, tijdelijkeOpslag, voegBetalingToe, voegFactuurToe } from './facturen-hulp.mjs';

const GEBRUIKER = 'bob';
const WACHTWOORD = 'een-wachtwoord-voor-de-test';
const INLOG = 'Basic ' + Buffer.from(`${GEBRUIKER}:${WACHTWOORD}`).toString('base64');

let opslag;
let graph;
let server;
let adres;
let pdfMap;

before(async () => {
  const tijdelijk = tijdelijkeOpslag();
  opslag = tijdelijk.opslag;
  pdfMap = tijdelijk.pdfMap;
  mkdirSync(pdfMap, { recursive: true });
  writeFileSync(path.join(pdfMap, 'factuur-een.pdf'), '%PDF-1.7\nnep\n%%EOF\n');
  graph = nepGraph();

  const gebouwd = maakServer({
    opslag, graph, claude: null, bunq: null, pdfMap,
    gebruiker: GEBRUIKER, wachtwoord: WACHTWOORD, basisPad: '/facturen',
    nu: () => '2026-10-06',
  });
  server = gebouwd.server;
  await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
  adres = `http://127.0.0.1:${server.address().port}/facturen`;
});

after(async () => {
  if (server) await new Promise((klaar) => server.close(klaar));
  ruimOp();
});

const haal = (pad, opties = {}) => fetch(adres + pad, {
  redirect: 'manual',
  ...opties,
  headers: { authorization: INLOG, ...(opties.headers || {}) },
});

// Een POST vanaf het dashboard zelf: same-origin.
const post = (pad, velden = {}, extra = {}) => haal(pad, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', ...(extra.headers || {}) },
  body: new URLSearchParams(velden).toString(),
});

test('zonder inlog geeft elke pagina 401 met een inlogverzoek', async () => {
  for (const pad of ['/', '/instellingen', '/factuur/1', '/dashboard.css']) {
    const antwoord = await fetch(adres + pad, { redirect: 'manual' });
    assert.equal(antwoord.status, 401, pad);
    assert.match(antwoord.headers.get('www-authenticate') || '', /^Basic realm=/, pad);
  }
});

test('een verkeerd wachtwoord geeft ook 401', async () => {
  const antwoord = await fetch(adres + '/', {
    headers: { authorization: 'Basic ' + Buffer.from(`${GEBRUIKER}:fout`).toString('base64') },
  });
  assert.equal(antwoord.status, 401);
});

test('met inlog geven alle pagina\'s 200', async () => {
  const factuur = voegFactuurToe(opslag, { message_id: 'web-1', attachment_id: 'a1' });

  for (const pad of ['/', '/?filter=alle', '/?filter=controle&zoek=tegel', '/instellingen', `/factuur/${factuur.id}`]) {
    const antwoord = await haal(pad);
    assert.equal(antwoord.status, 200, pad);
    assert.match(antwoord.headers.get('content-type'), /text\/html/, pad);
    const html = await antwoord.text();
    assert.match(html, /<html lang="nl">/, pad);
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, pad + ': precies één h1');
  }
});

test('de pagina\'s dragen een strikte CSP en worden niet geïndexeerd', async () => {
  const antwoord = await haal('/');
  const csp = antwoord.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.ok(!csp.includes("'unsafe-inline'"), 'geen unsafe-inline');
  assert.match(antwoord.headers.get('x-robots-tag'), /noindex/);
  assert.equal(antwoord.headers.get('x-content-type-options'), 'nosniff');
});

test('er staan geen inline styles of inline scripts in de pagina', async () => {
  const factuur = voegFactuurToe(opslag, { message_id: 'web-csp', attachment_id: 'a1' });
  for (const pad of ['/', '/instellingen', `/factuur/${factuur.id}`]) {
    const html = await (await haal(pad)).text();
    assert.ok(!/\sstyle="/.test(html), pad + ': geen style-attribuut');
    assert.ok(!/<script(?![^>]*\ssrc=)/.test(html), pad + ': geen inline script');
  }
});

test('css, js en de lettertypen worden uitgeleverd', async () => {
  const css = await haal('/dashboard.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.match(await css.text(), /--brons/);

  const js = await haal('/dashboard.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);

  const font = await haal('/fonts/inter-latin-wght.woff2');
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
});

test('het dashboard werkt onder een prefix: de links staan er ook onder', async () => {
  const html = await (await haal('/')).text();
  assert.match(html, /href="\/facturen\/dashboard\.css"/);
  assert.match(html, /action="\/facturen\/sync"/);
  assert.match(html, /href="\/facturen\/\?filter=alle&amp;sorteer=leverancier"|href="\/facturen\/\?sorteer=leverancier"/);
  assert.ok(!/href="\/dashboard\.css"/.test(html), 'geen link buiten de prefix om');
});

test('een POST van een andere site wordt geweigerd', async () => {
  const factuur = voegFactuurToe(opslag, { message_id: 'web-csrf', attachment_id: 'a1' });
  const antwoord = await haal(`/factuur/${factuur.id}/negeren`, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' },
    body: '',
  });
  assert.equal(antwoord.status, 403);
  assert.equal(opslag.factuur(factuur.id).status, 'open', 'er is niets gewijzigd');
});

test('markeren als betaald en terug naar open ontkoppelt de betaling', async () => {
  const factuur = voegFactuurToe(opslag, { message_id: 'web-betaald', attachment_id: 'a1' });
  voegBetalingToe(opslag, { id: 'web-p1' });

  // Eerst koppelen zoals het scherm dat doet.
  opslag.zetSuggestie(factuur.id, 'web-p1', 0.6);
  const koppelen = await post(`/factuur/${factuur.id}/koppel`, { betaling_id: 'web-p1' });
  assert.equal(koppelen.status, 303);
  assert.match(koppelen.headers.get('location'), /^\/facturen\/factuur\/\d+\?m=gekoppeld$/);

  const betaald = opslag.factuur(factuur.id);
  assert.equal(betaald.status, 'betaald');
  assert.equal(betaald.betaald_via, 'bunq');
  assert.equal(betaald.bunq_betaling_id, 'web-p1');
  assert.equal(opslag.betaling('web-p1').gekoppelde_factuur_id, factuur.id);

  const terug = await post(`/factuur/${factuur.id}/open`);
  assert.equal(terug.status, 303);

  const open = opslag.factuur(factuur.id);
  assert.equal(open.status, 'open');
  assert.equal(open.betaald_op, null);
  assert.equal(open.betaald_via, null);
  assert.equal(open.bunq_betaling_id, null);
  assert.equal(opslag.betaling('web-p1').gekoppelde_factuur_id, null, 'de betaling is weer vrij');
});

test('met de hand op betaald zetten gebruikt de opgegeven datum', async () => {
  const factuur = voegFactuurToe(opslag, { message_id: 'web-hand', attachment_id: 'a1' });
  await post(`/factuur/${factuur.id}/betaald`, { betaald_op: '2026-10-02' });

  const na = opslag.factuur(factuur.id);
  assert.equal(na.status, 'betaald');
  assert.equal(na.betaald_via, 'handmatig');
  assert.equal(na.betaald_op, '2026-10-02');
});

test('negeren, opnieuw uitlezen en bewerken doen wat ze zeggen', async () => {
  const factuur = voegFactuurToe(opslag, { message_id: 'web-acties', attachment_id: 'a1' });

  await post(`/factuur/${factuur.id}/negeren`);
  assert.equal(opslag.factuur(factuur.id).status, 'genegeerd');

  await post(`/factuur/${factuur.id}/opnieuw`);
  assert.equal(opslag.factuur(factuur.id).uitlees_status, 'pending');

  await post(`/factuur/${factuur.id}/bewerken`, {
    leverancier: 'Handmatig Ingevuld BV',
    factuurnummer: 'HAND-1',
    factuurdatum: '2026-09-30',
    vervaldatum: '',
    bedrag: '2.420,50',
    valuta: 'eur',
    iban: 'nl91 abna 0417 1643 00',
    betalingskenmerk: '',
    omschrijving: 'met de hand',
    notitie: 'nagekeken door Bob',
  });

  const na = opslag.factuur(factuur.id);
  assert.equal(na.uitlees_status, 'handmatig');
  assert.equal(na.leverancier, 'Handmatig Ingevuld BV');
  assert.equal(na.bedrag, 2420.5, 'het bedrag is uit de Nederlandse notatie gelezen');
  assert.equal(na.valuta, 'EUR');
  assert.equal(na.iban, 'NL91ABNA0417164300');
  assert.equal(na.vervaldatum, null, 'een leeg veld wordt leeg opgeslagen');
  assert.equal(na.notitie, 'nagekeken door Bob');
});

test('doorsturen zonder boekhouderadres verstuurt niets en meldt dat', async () => {
  const factuur = voegFactuurToe(opslag, { message_id: 'web-geen-adres', attachment_id: 'a1' });
  const voor = graph.verstuurd.length;

  const antwoord = await post(`/factuur/${factuur.id}/doorsturen`);
  assert.equal(antwoord.status, 303);
  assert.match(antwoord.headers.get('location'), /m=geen-adres$/);
  assert.equal(graph.verstuurd.length, voor, 'er is niets verstuurd');

  // De melding staat ook echt in het scherm.
  const html = await (await haal(`/factuur/${factuur.id}?m=geen-adres`)).text();
  assert.match(html, /geen e-mailadres van de boekhouder/);
});

test('zonder adres is de doorstuurknop uitgeschakeld', async () => {
  const factuur = voegFactuurToe(opslag, { message_id: 'web-knop', attachment_id: 'a1' });
  const html = await (await haal(`/factuur/${factuur.id}`)).text();
  assert.match(html, /Doorsturen naar boekhouder<\/button>/);
  assert.match(html, /type="submit" disabled>\s*\n?\s*Doorsturen naar boekhouder/);
});

test('instellingen opslaan werkt, een fout laat de pagina staan', async () => {
  const fout = await post('/instellingen', { boekhouder_email: 'geen-adres', match_drempel: '0.7', terugkijken_dagen: '365' });
  assert.equal(fout.status, 400);
  assert.match(await fout.text(), /Geen geldig e-mailadres/);

  const goed = await post('/instellingen', {
    boekhouder_email: 'boekhouder@kantoor.nl',
    doorstuur_tekst: 'Hierbij een betaalde factuur.',
    auto_doorsturen: '1',
    match_drempel: '0.8',
    terugkijken_dagen: '180',
  });
  assert.equal(goed.status, 303);
  assert.match(goed.headers.get('location'), /m=opgeslagen$/);

  const inst = instellingen.lees(opslag);
  assert.deepEqual(inst.boekhouderEmails, ['boekhouder@kantoor.nl']);
  assert.equal(inst.autoDoorsturen, true);
  assert.equal(inst.testmodus, false, 'een niet-aangevinkt vakje zet de schakelaar uit');
  assert.equal(inst.matchDrempel, 0.8);
  assert.ok(inst.autoDoorsturenSinds, 'het startmoment is vastgelegd');
});

test('met een adres verstuurt de knop wél, en de factuur staat daarna als doorgestuurd', async () => {
  const factuur = voegFactuurToe(opslag, { message_id: 'web-stuur', attachment_id: 'a1' });
  await post(`/factuur/${factuur.id}/betaald`, { betaald_op: '2026-10-06' });
  const voor = graph.verstuurd.length;

  const antwoord = await post(`/factuur/${factuur.id}/doorsturen`);
  assert.equal(antwoord.status, 303);
  assert.match(antwoord.headers.get('location'), /m=doorgestuurd$/);
  assert.equal(graph.verstuurd.length, voor + 1);
  assert.equal(opslag.factuur(factuur.id).doorgestuurd_naar, 'boekhouder@kantoor.nl');
});

test('de verbindingstest meldt eerlijk wat er niet is ingesteld', async () => {
  const antwoord = await post('/instellingen/test');
  assert.equal(antwoord.status, 200);
  const html = await antwoord.text();
  assert.match(html, /bunq<\/strong> — <span class="nee">werkt niet<\/span>: bunq is niet ingesteld/);
  assert.match(html, /Claude<\/strong> — <span class="nee">werkt niet<\/span>: geen ANTHROPIC_API_KEY/);
});

test('de PDF komt alleen uit de pdf-map', async () => {
  const metPdf = voegFactuurToe(opslag, { message_id: 'web-pdf', attachment_id: 'a1' });
  opslag.db.prepare('UPDATE facturen SET pdf_pad = ? WHERE id = ?').run('factuur-een.pdf', metPdf.id);

  const goed = await haal(`/factuur/${metPdf.id}/pdf`);
  assert.equal(goed.status, 200);
  assert.equal(goed.headers.get('content-type'), 'application/pdf');
  assert.match(await goed.text(), /^%PDF-1\.7/);

  // Een pad dat uit de map probeert te breken komt nooit bij het bestand.
  opslag.db.prepare('UPDATE facturen SET pdf_pad = ? WHERE id = ?').run('../../../etc/passwd', metPdf.id);
  const ontsnapping = await haal(`/factuur/${metPdf.id}/pdf`);
  assert.equal(ontsnapping.status, 404, 'alleen de bestandsnaam telt, dus passwd bestaat niet in de pdf-map');

  const zonderPdf = voegFactuurToe(opslag, { message_id: 'web-zonder-pdf', attachment_id: '' });
  assert.equal((await haal(`/factuur/${zonderPdf.id}/pdf`)).status, 404);
});

test('een onbekende factuur en een onbekend pad geven 404', async () => {
  assert.equal((await haal('/factuur/999999')).status, 404);
  assert.equal((await haal('/bestaat-niet')).status, 404);
});

test('de syncknop start een ronde en zegt dat', async () => {
  const antwoord = await post('/sync');
  assert.equal(antwoord.status, 303);
  assert.match(antwoord.headers.get('location'), /m=sync-gestart$/);
  assert.ok(opslag.logboek(20).some((r) => /met de hand gestart/.test(r.bericht)));
});

test('uitEnv leest de env en houdt veilige standaarden aan', () => {
  const leeg = uitEnv({});
  assert.equal(leeg.poort, 8132);
  assert.equal(leeg.dataMap, '/var/lib/dekoning-facturen');
  assert.equal(leeg.pdfMap, '/var/lib/dekoning-facturen/pdfs');
  assert.equal(leeg.basisPad, '');
  assert.equal(leeg.syncMinuten, 15);
  assert.equal(leeg.claude.model, 'claude-sonnet-5-5');
  assert.equal(leeg.bunq.omgeving, 'production');
  assert.deepEqual(leeg.bunq.ibans, []);

  const gevuld = uitEnv({
    DATA_DIR: '/tmp/data', BASIS_PAD: '/facturen', SYNC_INTERVAL_MIN: '30',
    CLAUDE_MODEL: 'claude-opus-5-5', BUNQ_ENV: 'sandbox',
    BUNQ_ACCOUNT_IBANS: 'nl91 abna 0417 1643 00, onzin',
    M365_FOLDER: 'Facturen/2026',
  });
  assert.equal(gevuld.dbPad, '/tmp/data/facturen.db');
  assert.equal(gevuld.bunqStatePad, '/tmp/data/bunq_state.json');
  assert.equal(gevuld.syncMinuten, 30);
  assert.equal(gevuld.bunq.omgeving, 'sandbox');
  assert.deepEqual(gevuld.bunq.ibans, ['NL91ABNA0417164300'], 'onzin valt eruit');
  assert.equal(gevuld.m365.map, 'Facturen/2026');
});

test('zonder DASHBOARD_USER draait de dienst, maar laat hij niemand binnen', async () => {
  const { opslag: eigen, pdfMap: eigenPdf } = tijdelijkeOpslag();
  const { server: kaal } = maakServer({ opslag: eigen, pdfMap: eigenPdf, gebruiker: '', wachtwoord: '' });
  await new Promise((klaar) => kaal.listen(0, '127.0.0.1', klaar));

  const antwoord = await fetch(`http://127.0.0.1:${kaal.address().port}/`);
  assert.equal(antwoord.status, 503);
  assert.match(await antwoord.text(), /DASHBOARD_USER en DASHBOARD_PASSWORD ontbreken/);

  await new Promise((klaar) => kaal.close(klaar));
});
