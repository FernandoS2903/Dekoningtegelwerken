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
import { nepGraph } from './facturen-hulp.mjs';
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
    await browser.evalueer(`document.querySelectorAll('details').forEach((d) => { d.open = true; })`);
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
