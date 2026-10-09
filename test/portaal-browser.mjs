// Browsertest voor het portaal (startpagina en Mail): geen horizontale
// overflow, klikvlakken groot genoeg op 390 px, geen JS-fouten of mislukte
// verzoeken, en Andere map werkt zonder JavaScript-trucs (details).
//
// Draait los van `node --test`, want hij heeft een Chromium nodig:
//   export CHROME=$(ls -d ~/.cache/ms-playwright/chromium_headless_shell-*/*/ | head -1)chrome-headless-shell
//   node test/portaal-browser.mjs [map-voor-schermafdrukken]
//
// Start zelf een portaal (Basic Auth, zoals zonder SSO) met voorbeeldgegevens
// op een vrije poort; er gaat niets naar buiten.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startBrowser, wacht } from './cdp.mjs';
import { maakBasicAuth, maakFacturenApp } from '../service/facturen/server.mjs';
import { maakPortaal } from '../service/facturen/portaal.mjs';
import { maakMailApp } from '../service/facturen/mail.mjs';
import { maakOpslag, openDatabase } from '../service/facturen/lib/db.mjs';
import { maakSorteerOpslag } from '../service/facturen/lib/sorteer-opslag.mjs';
import { maakSorteerder } from '../service/facturen/lib/sorteren.mjs';
import { maakWebhook } from '../service/facturen/lib/webhook.mjs';
import * as instellingen from '../service/facturen/lib/instellingen.mjs';
import { nepGraph, voegFactuurToe, voegBetalingToe } from './facturen-hulp.mjs';
import { nepMailbox } from './mail-hulp.mjs';

const BREEDTES = [360, 390, 820, 1440];
const afdrukken = process.argv[2] || null;

let geslaagd = 0;
const gezakt = [];
function controleer(omschrijving, goed, extra = '') {
  if (goed) { geslaagd++; console.log('  ok  ' + omschrijving); } else {
    gezakt.push(omschrijving + (extra ? ' — ' + extra : ''));
    console.log('  FOUT ' + omschrijving + (extra ? ' — ' + extra : ''));
  }
}

// -- voorbeeldgegevens -------------------------------------------------------
const map = mkdtempSync(path.join(os.tmpdir(), 'dekoning-portaal-browser-'));
mkdirSync(path.join(map, 'pdfs'), { recursive: true });
const opslag = maakOpslag(openDatabase(path.join(map, 'facturen.db')));
const sorteerOpslag = maakSorteerOpslag(opslag.db);
instellingen.bewaar(opslag, { website_afzenders: 'formulier@voorbeeld-formulier.nl' });

const nu = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const VOORBEELD = [
  ['Tegelhandel Zuid', 'facturen@tegelhandelzuid.nl', 'Factuur 2026-0123 met een wat langer onderwerp dan gebruikelijk', 'Facturen', 'ai', 0.96, 'pdf-bijlage factuur.pdf met factuurnummer', 'verplaatst'],
  ['Familie Jansen', 'jansen.familie.met.een.lang.adres@voorbeeldprovider.nl', 'Offerte badkamer 8 m²', 'Offerteaanvragen', 'website', 1, 'afzender staat bij de website-afzenders', 'verplaatst'],
  ['Bouwmaat', 'nieuws@bouwmaat.nl', 'Deze week in de aanbieding', 'Nieuwsbrieven & reclame', 'regel', 1, 'regel op domein bouwmaat.nl', 'verplaatst'],
  ['Onbekend', 'info@iets.nl', 'Vraag', 'Klanten & projecten', 'ai', 0.55, 'mogelijk klant, weinig context', 'controleren'],
  ['Agenda', 'bob@dekoningtegelwerken.nl', 'Overleg', null, 'overgeslagen', null, 'agenda-uitnodiging', 'overgeslagen'],
  ['Leverancier', 'order@groothandel.nl', 'Orderbevestiging', 'Leveranciers', 'ai', null, 'beoordelen mislukt', 'fout'],
];
VOORBEELD.forEach(([naam, adres, onderwerp, naar, bron, zekerheid, reden, status], i) => {
  sorteerOpslag.log({
    tijd: nu, message_id: 'm' + i, internet_id: `<m${i}@x>`, ontvangen: nu, afzender_naam: naam, afzender: adres,
    onderwerp, van_map: 'Inbox', naar_map: naar, huidige_map: status === 'verplaatst' ? naar : 'Inbox',
    bron, zekerheid, reden, status, fout: status === 'fout' ? 'Claude-limiet bereikt (429)' : null,
  });
});
sorteerOpslag.voegRegelToe({ soort: 'domein', waarde: 'bouwmaat.nl', map: 'Nieuwsbrieven & reclame', door: 'bob' });
sorteerOpslag.voegRegelToe({ soort: 'adres', waarde: 'facturen@tegelhandelzuid.nl', map: 'Facturen', door: 'bob' });

// Facturen in alle standen, zodat tabel, dashboard en zijpaneel gevuld zijn.
const FACTUREN = [
  ['Tegelhandel Zuid B.V.', 1210, '2026-10-01', '2026-10-31', 'open'],
  ['Bouwmaat Velsen', 348.7, '2026-09-20', '2026-09-30', 'open'],
  ['Natuursteen Import', 5400, '2026-08-11', '2026-09-10', 'betaald'],
  ['Van Dijk Voegmiddelen', 89.95, '2026-10-03', '2026-11-02', 'open'],
  ['Een Leverancier Met Een Opvallend Lange Naam B.V.', 1899, '2026-07-02', '2026-08-01', 'betaald'],
];
FACTUREN.forEach(([naam, bedrag, datum, verval, status], i) => {
  const f = voegFactuurToe(opslag, {
    message_id: 'f' + i, attachment_id: 'a', ontvangen: datum + 'T09:00:00Z', afzender_naam: naam,
    onderwerp: 'Factuur ' + (2000 + i), leverancier: naam, factuurnummer: '2026-' + (100 + i),
    factuurdatum: datum, vervaldatum: verval, bedrag,
  });
  if (status === 'betaald') opslag.zetBetaald(f.id, { betaald_op: verval, betaald_via: 'handmatig' });
});
const { id: stuk } = opslag.voegFactuurToe({ message_id: 'stuk', attachment_id: '', onderwerp: 'Onleesbare scan', afzender_naam: 'Onbekend', ontvangen: '2026-10-04T09:00:00Z' });
opslag.zetUitleesFout(stuk, 'het model weigerde dit document te lezen');
voegBetalingToe(opslag, { id: '9001', bedrag: -89.95, tegenpartij_naam: 'V. Dijk', omschrijving: 'overboeking', tegenrekening_iban: null });
opslag.zetSuggestie(4, '9001', 0.6);

const mail = nepMailbox();
const facturen = maakFacturenApp({ opslag, graph: nepGraph(), pdfMap: path.join(map, 'pdfs'), basisPad: '/facturen' });
const sorteerder = maakSorteerder({ sorteerOpslag, mail, classificeerder: null, instellingenLezer: () => instellingen.lees(opslag) });
const webhook = maakWebhook({ mail, sorteerOpslag, sorteerder, actief: false });
const mailApp = maakMailApp({ opslag, sorteerOpslag, sorteerder, webhook, mail, basisPad: '/mail' });
const auth = { modus: 'basic', basic: maakBasicAuth({ gebruiker: 'bob', wachtwoord: 'browsertest' }), geheim: 'x'.repeat(40) };
const { server } = maakPortaal({
  opslag, sorteerOpslag, facturen, mailApp, webhook, auth,
  offertesUrl: 'https://de-koning-tegelwerken.offerteknop.nl/offertes/',
});
await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
const basis = `http://127.0.0.1:${server.address().port}`;

const browser = await startBrowser(process.env.CHROME, 9343);
await browser.s('Network.setExtraHTTPHeaders', {
  headers: { Authorization: 'Basic ' + Buffer.from('bob:browsertest').toString('base64') },
});

async function afdruk(naam) {
  if (!afdrukken) return;
  mkdirSync(afdrukken, { recursive: true });
  const { data } = await browser.s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(path.join(afdrukken, naam + '.png'), Buffer.from(data, 'base64'));
}

const PAGINAS = [
  ['start', '/'],
  ['facturen', '/facturen/'],
  ['facturen, alle, op bedrag', '/facturen/?filter=alle&sorteer=bedrag-af'],
  ['factuur', '/facturen/factuur/1'],
  ['leveranciers', '/facturen/leveranciers'],
  ['mail', '/mail/'],
  ['mail, filter controleren', '/mail/?status=controleren'],
  ['regels', '/mail/regels'],
  ['instellingen mail', '/mail/instellingen'],
];

const OVERFLOW = `(() => {
  const uit = [];
  const scrollbaar = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (getComputedStyle(n).overflowX === 'auto') return true;
    }
    return false;
  };
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.right > window.innerWidth + 1 && !scrollbaar(el)) {
      uit.push(el.tagName.toLowerCase() + '.' + (el.className || '') + ' tot ' + Math.round(r.right));
    }
  }
  return { paginaBreed: document.documentElement.scrollWidth, venster: window.innerWidth, uit: uit.slice(0, 3) };
})()`;

const KLIKVLAK = `(() => {
  const uit = [];
  for (const el of document.querySelectorAll('a, button, summary, select, input[type="checkbox"], input[type="radio"]')) {
    let doel = el;
    if (el.tagName === 'INPUT') doel = el.closest('label') || document.querySelector('label[for="' + el.id + '"]') || el;
    const r = doel.getBoundingClientRect();
    if (r.height === 0) continue;
    if (r.height < 40) uit.push(el.tagName.toLowerCase() + ' "' + (doel.textContent || '').trim().slice(0, 25) + '" ' + Math.round(r.height) + 'px');
  }
  return uit;
})()`;

for (const [naam, pad] of PAGINAS) {
  console.log('\n' + naam);
  for (const breedte of BREEDTES) {
    await browser.viewport(breedte, 900, breedte < 700);
    await browser.open(basis + pad, 500);
    // Alle "Andere map"-blokken open, zodat ook het formulier meetelt.
    await browser.evalueer(`document.querySelectorAll('details.mailrij__anders').forEach((d) => { d.open = true; })`);
    await wacht(100);
    const r = await browser.evalueer(OVERFLOW);
    controleer(`${breedte} px: geen horizontale overflow`, r.paginaBreed <= r.venster + 1 && r.uit.length === 0,
      `pagina ${r.paginaBreed} px in ${r.venster} px; ${r.uit.join(' | ')}`);
    if (breedte === 390 || breedte === 1440) await afdruk(`${naam.replace(/[^a-z]+/g, '-')}-${breedte}`);
  }
  await browser.viewport(390, 900, true);
  await browser.open(basis + pad, 400);
  await browser.evalueer(`document.querySelectorAll('details').forEach((d) => { d.open = true; })`);
  const teKlein = await browser.evalueer(KLIKVLAK);
  controleer('390 px: klikvlakken minstens 40 px', teKlein.length === 0, teKlein.slice(0, 4).join(' | '));
}

// -- zijpaneel op desktop: rij klikken, paneel laden, actie via fetch -------------
console.log('\nzijpaneel');
await browser.viewport(1440, 900, false);
await browser.open(basis + '/facturen/?filter=alle', 600);
await browser.evalueer(`document.querySelector('.rij[data-factuur="2"]').click()`);
await wacht(700);
const paneelStand = await browser.evalueer(`(() => {
  const p = document.querySelector('[data-zijpaneel]');
  return { open: !p.hidden && document.body.classList.contains('paneel-open'), kop: p.querySelector('h2')?.textContent || '',
    url: location.pathname, actief: document.querySelector('.rij.actief')?.dataset.factuur || null,
    pdf: Boolean(p.querySelector('.pdf, .maildump')), lijstZichtbaar: getComputedStyle(document.querySelector('[data-lijst]')).display !== 'none' };
})()`);
controleer('het paneel opent naast de lijst', paneelStand.open && paneelStand.lijstZichtbaar, JSON.stringify(paneelStand));
controleer('het paneel toont de factuur en de URL verandert mee', /Bouwmaat/.test(paneelStand.kop) && paneelStand.url === '/facturen/factuur/2' && paneelStand.actief === '2', JSON.stringify(paneelStand));
await afdruk('facturen-zijpaneel-1440');

// Negeren vanuit het paneel: bevestiging, daarna via fetch; de lijst ververst.
let dialoog = null;
browser.opEvent('Page.javascriptDialogOpening', (p) => { dialoog = p.message; });
browser.s('Runtime.evaluate', { expression: `document.querySelector('[data-zijpaneel] form[action$="/negeren"] button').click()` }).catch(() => {});
await wacht(500);
controleer('negeren vraagt eerst om bevestiging', /negeren/i.test(dialoog || ''), String(dialoog));
await browser.s('Page.handleJavaScriptDialog', { accept: true });
await wacht(900);
const naActie = await browser.evalueer(`(() => ({
  melding: document.querySelector('[data-zijpaneel] .melding')?.textContent.trim() || '',
  vlag: document.querySelector('.rij[data-factuur="2"] .rij__status')?.textContent.trim() || '',
  url: location.pathname + location.search,
}))()`);
controleer('de actie is verwerkt en het paneel toont de melding', /genegeerd/i.test(naActie.melding) && opslag.factuur(2).status === 'genegeerd', JSON.stringify(naActie));
controleer('de lijst is ververst zonder herladen', /genegeerd/i.test(naActie.vlag), JSON.stringify(naActie));

await browser.evalueer(`document.querySelector('[data-paneel-sluit]').click()`);
await wacht(400);
controleer('sluiten verbergt het paneel', await browser.evalueer(`document.querySelector('[data-zijpaneel]').hidden && !document.body.classList.contains('paneel-open')`));

// Op mobiel opent een rij gewoon de pagina.
await browser.viewport(390, 900, true);
await browser.open(basis + '/facturen/?filter=alle', 500);
await browser.evalueer(`document.querySelector('.rij[data-factuur="1"]').click()`);
await wacht(600);
controleer('op mobiel opent de factuurpagina', await browser.evalueer('location.pathname') === '/facturen/factuur/1');

// Grafiek: tooltip bij focus op een staaf.
await browser.viewport(1440, 900, false);
await browser.open(basis + '/', 500);
const tip = await browser.evalueer(`(() => { const s = document.querySelector('.staaf[data-aantal]:not([data-aantal="0"])'); if (!s) return null; s.focus(); const t = document.querySelector('.grafiek__tip'); return { hidden: t.hidden, tekst: t.textContent }; })()`);
controleer('de grafiek toont een tooltip bij een staaf', tip && !tip.hidden && /€/.test(tip.tekst), JSON.stringify(tip));
await afdruk('start-gevuld-1440');

// -- Andere map: kiezen en versturen, met het CSRF-token uit de pagina -----
console.log('\nandere map vanuit het logboek');
await browser.viewport(390, 900, true);
await browser.open(basis + '/mail/', 500);
await browser.evalueer(`(() => {
  const d = document.querySelector('.mailrij__anders');
  d.open = true;
  d.querySelector('select').value = 'Leveranciers';
  d.querySelector('input[value="domein"]').checked = true;
  d.querySelector('form').submit();
})()`);
await wacht(800);
const melding = await browser.evalueer(`document.querySelector('.melding')?.textContent || ''`);
// De nagebootste mailbox verplaatst; het eerste item (Tegelhandel Zuid) heeft
// een adresregel, de nieuwe regel is op het domein.
controleer('verplaatst en regel gemaakt', /regel gemaakt/.test(melding), melding.trim());
controleer('de regel staat erin', Boolean(sorteerOpslag.regelVoor('iemand@leverancier-voorbeeld.nl') === null
  && sorteerOpslag.regels().some((r) => r.soort === 'domein' && r.map === 'Leveranciers')));

const echteFouten = browser.fouten.filter((f) => !/favicon/i.test(f));
controleer('geen JS-fouten of mislukte verzoeken', echteFouten.length === 0, echteFouten.slice(0, 3).join(' | '));

browser.stop();
await new Promise((klaar) => server.close(klaar));
rmSync(map, { recursive: true, force: true });

console.log(`\n${geslaagd} geslaagd, ${gezakt.length} gezakt`);
if (gezakt.length) {
  for (const regel of gezakt) console.log('  - ' + regel);
  process.exit(1);
}
