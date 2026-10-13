// Browsertest voor betalen via bunq: de knop in het factuurpaneel, de
// selectie, het bevestigingsscherm (nieuw en afwijkend IBAN) en de
// instellingen, op 360, 390 en 1440 px. Geen horizontale overflow, klikvlakken
// groot genoeg op mobiel, een bevestiging vóór het klaarzetten, geen
// JS-fouten. bunq is nagebootst: er gaat niets naar buiten.
//
// Draait los van `node --test`, want hij heeft een Chromium nodig:
//   export CHROME=$(ls -d ~/.cache/ms-playwright/chromium_headless_shell-*/*/ | head -1)chrome-headless-shell
//   node test/betalen-browser.mjs [map-voor-schermafdrukken]

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { startBrowser, wacht } from './cdp.mjs';
import { maakFacturenApp } from '../service/facturen/server.mjs';
import { maakOpslag, openDatabase } from '../service/facturen/lib/db.mjs';
import * as instellingen from '../service/facturen/lib/instellingen.mjs';
import { STATISCH, stuurStatisch } from '../service/facturen/web/statisch.mjs';
import { leverancierSleutel } from '../service/facturen/lib/betalen.mjs';
import { nepBunq, voegFactuurToe } from './facturen-hulp.mjs';

const BREEDTES = [360, 390, 1440];
const afdrukken = process.argv[2] || null;
if (afdrukken) mkdirSync(afdrukken, { recursive: true });

let geslaagd = 0;
const gezakt = [];
function controleer(omschrijving, goed, extra = '') {
  if (goed) { geslaagd++; console.log('  ok  ' + omschrijving); } else {
    gezakt.push(omschrijving + (extra ? ' — ' + extra : ''));
    console.log('  FOUT ' + omschrijving + (extra ? ' — ' + extra : ''));
  }
}

// -- voorbeeldgegevens -------------------------------------------------------
const map = mkdtempSync(path.join(os.tmpdir(), 'dekoning-betalen-browser-'));
mkdirSync(path.join(map, 'pdfs'), { recursive: true });
const opslag = maakOpslag(openDatabase(path.join(map, 'facturen.db')));
instellingen.bewaar(opslag, {
  betalen_rekening_id: '42', betalen_rekening_iban: 'NL00BUNQ0000000042', betalen_rekening_naam: 'Zakelijk',
  betalen_aan: '1', betalen_max: '5000',
});

const f = (velden) => voegFactuurToe(opslag, { message_id: 'm' + Math.random(), ...velden });
const gewoon = f({});
const langeNaam = f({ leverancier: 'Een Leverancier Met Een Opvallend Lange Naam Voor Natuursteen B.V.', iban: 'NL20INGB0001234567', iban_naam: 'Een Leverancier Met Een Opvallend Lange Naam Voor Natuursteen B.V.', bedrag: 2350.5, betalingskenmerk: '1234 5678 9012 3456', factuurnummer: 'NS-2026-000123' });
f({ leverancier: 'Bouwmaat Velsen', betaalwijze: 'incasso', bedrag: 348.7 });
f({ leverancier: 'Van Dijk Voegmiddelen', iban: null, bedrag: 89.95 });
const loopt = f({ leverancier: 'Groothandel Noord', iban: 'NL39RABO0300065264', bedrag: 120 });
// Tegelhandel Zuid is eerder betaald op het IBAN van "gewoon"; deze factuur
// heeft een ander IBAN en is dus afwijkend.
const afwijkend = f({ iban: 'NL02ABNA0123456789', factuurnummer: '2026-0199', bedrag: 640 });
opslag.db.prepare(`INSERT INTO leverancier_ibans (leverancier, naam, iban, status, bevestigd_door, bevestigd_op, vertrouwd_op)
  VALUES (?, 'Tegelhandel Zuid B.V.', 'NL91ABNA0417164300', 'vertrouwd', 'bob@voorbeeld.nl', '2026-09-01T10:00:00Z', '2026-09-01T10:05:00Z')`).run(leverancierSleutel(gewoon));

const bunq = nepBunq();
const kader = { modus: 'sso', email: 'bob@voorbeeld.nl', naam: 'Bob de Koning', csrf: 'test-csrf' };
const app = maakFacturenApp({ opslag, bunq, pdfMap: path.join(map, 'pdfs'), basisPad: '/facturen', nu: () => '2026-10-14' });

// Een lopende conceptbetaling voor "loopt".
{
  const v = app.betaler.voorbereiden([loopt.id], { inst: instellingen.lees(opslag), kader });
  await app.betaler.aanmaken({
    ids: [loopt.id], sleutel: 'browser-test-sleutel-0001', afdruk: v.vingerafdruk,
    body: new URLSearchParams({ id: String(loopt.id), [`nieuw_${loopt.id}`]: '1' }), inst: instellingen.lees(opslag), kader,
  });
}

const server = http.createServer((req, res) => {
  const pad = new URL(req.url, 'http://x').pathname;
  if (STATISCH[pad]) return stuurStatisch(res, pad, {});
  if (pad.startsWith('/facturen')) return app.handle(req, res, { kader });
  res.writeHead(404).end();
});
await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
const basis = `http://127.0.0.1:${server.address().port}/facturen`;

const browser = await startBrowser(process.env.CHROME, 9346);
await browser.s('Page.enable');
let dialoog = null;
let antwoord = true;
browser.opEvent('Page.javascriptDialogOpening', (p) => {
  dialoog = p.message;
  browser.s('Page.handleJavaScriptDialog', { accept: antwoord }).catch(() => {});
});

async function afdruk(naam) {
  if (!afdrukken) return;
  const { data } = await browser.s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(path.join(afdrukken, naam + '.png'), Buffer.from(data, 'base64'));
}

const PAGINAS = [
  ['lijst', '/'],
  ['factuur met knop', `/factuur/${gewoon.id}`],
  ['factuur met lopende draft', `/factuur/${loopt.id}`],
  ['factuur met incasso', `/factuur/${gewoon.id + 2}`],
  ['selectie', '/betalen'],
  ['bevestigen (nieuw en afwijkend IBAN)', `/betalen/bevestig?id=${langeNaam.id}&id=${afwijkend.id}`],
  ['instellingen', '/instellingen'],
];

for (const [naam, pad] of PAGINAS) {
  console.log('\n' + naam);
  for (const breedte of BREEDTES) {
    await browser.viewport(breedte, 900, breedte < 700);
    await browser.open(basis + pad, 450);
    const teBreed = await browser.evalueer(`(() => {
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
        if (r.right > window.innerWidth + 1 && !scrollbaar(el)) uit.push(el.tagName.toLowerCase() + '.' + (el.className || '') + ' tot ' + Math.round(r.right));
      }
      return { breed: document.documentElement.scrollWidth, venster: window.innerWidth, uit: uit.slice(0, 3) };
    })()`);
    controleer(`${breedte} px: geen horizontale overflow`, teBreed.breed <= teBreed.venster + 1 && !teBreed.uit.length,
      `pagina ${teBreed.breed} in ${teBreed.venster}; ${teBreed.uit.join(' | ')}`);
    await afdruk(`${naam.replace(/[^a-z0-9]+/gi, '-')}-${breedte}`);

    if (breedte < 700) {
      // Klikvlakken minstens 44 px (zelfde maat als de andere browsertests);
      // bij een selectievakje telt het label.
      const teKlein = await browser.evalueer(`(() => {
        const uit = [];
        for (const el of document.querySelectorAll('main a, main button, main input[type="checkbox"], main select, main input[type="text"], main input[type="number"]')) {
          let doel = el;
          if (el.tagName === 'INPUT' && el.type === 'checkbox' && el.id) doel = document.querySelector('label[for="' + el.id + '"]') || el;
          const r = doel.getBoundingClientRect();
          if (r.height === 0) continue;
          if (r.height < 44) uit.push(el.tagName.toLowerCase() + ' "' + (doel.textContent || el.name || '').trim().slice(0, 25) + '" ' + Math.round(r.height) + 'px');
        }
        return uit;
      })()`);
      controleer(`${breedte} px: klikvlakken groot genoeg`, !teKlein.length, teKlein.slice(0, 3).join(' | '));
    }
  }
}

// -- inhoud -----------------------------------------------------------------------
console.log('\ninhoud');
await browser.viewport(390, 900, true);
await browser.open(basis + `/factuur/${gewoon.id}`, 400);
controleer('factuur: knop "Betalen via bunq"', await browser.evalueer(`[...document.querySelectorAll('a')].some((a) => a.textContent.trim() === 'Betalen via bunq')`));
await browser.open(basis + `/factuur/${loopt.id}`, 400);
controleer('lopende draft: stand en "keur goed in de app"', await browser.evalueer(`/klaargezet in bunq — keur goed in de app/.test(document.body.textContent)`));
await browser.open(basis + `/factuur/${gewoon.id + 2}`, 400);
controleer('incasso: geen knop, wel de reden', await browser.evalueer(`!/>Betalen via bunq</.test(document.body.innerHTML) && /geïncasseerd/.test(document.body.textContent)`));
await browser.open(basis + `/betalen/bevestig?id=${langeNaam.id}&id=${afwijkend.id}`, 400);
controleer('bevestigen: afwijkend IBAN met waarschuwing en veld voor de laatste vier', await browser.evalueer(
  `/dit IBAN wijkt af/i.test(document.body.textContent) && Boolean(document.querySelector('input[name="laatste4_${afwijkend.id}"]'))`));
controleer('bevestigen: van-rekening en totaal staan erbij', await browser.evalueer(`/Zakelijk/.test(document.body.textContent) && /2\\.990,50/.test(document.body.textContent)`));

// -- desktop: zijpaneel, knop, naar het bevestigingsscherm ---------------------------
console.log('\ndesktop: vanuit het zijpaneel');
await browser.viewport(1440, 900, false);
await browser.open(basis + '/', 500);
await browser.evalueer(`document.querySelector('.rij[data-factuur="${gewoon.id}"]').click()`);
await wacht(500);
controleer('het zijpaneel toont de knop', await browser.evalueer(`Boolean([...document.querySelectorAll('[data-zijpaneel] a')].find((a) => a.textContent.trim() === 'Betalen via bunq'))`));
await browser.evalueer(`[...document.querySelectorAll('[data-zijpaneel] a')].find((a) => a.textContent.trim() === 'Betalen via bunq').click()`);
await wacht(600);
controleer('de knop opent het bevestigingsscherm als pagina', await browser.evalueer(`location.pathname.endsWith('/betalen/bevestig') && /Betaling controleren/.test(document.title)`));

// -- mobiel: selectie, bevestigen met dialoog, klaarzetten ------------------------
console.log('\nmobiel: selecteren en klaarzetten');
await browser.viewport(390, 900, true);
await browser.open(basis + '/betalen', 500);
const aantalKeuzes = await browser.evalueer(`document.querySelectorAll('input[name="id"]').length`);
controleer('alleen betaalbare facturen zijn aan te vinken (3)', aantalKeuzes === 3, String(aantalKeuzes));
const kies = `for (const id of [${gewoon.id}, ${langeNaam.id}]) document.querySelector('label[for="kies-' + id + '"]').click()`;
await browser.evalueer(kies);
await browser.evalueer(`document.querySelector('form.kieslijst button[type="submit"]').click()`);
await wacht(600);
controleer('selectie gaat naar het bevestigingsscherm met 2 regels', await browser.evalueer(`document.querySelectorAll('.betaalregel').length === 2`));

// Eerst zonder de nieuwe IBAN's te bevestigen: de server weigert.
dialoog = null;
antwoord = true;
browser.s('Runtime.evaluate', { expression: `document.querySelector('form.bevestig button[type="submit"]').click()` }).catch(() => {});
await wacht(900);
controleer('vóór het klaarzetten wordt om bevestiging gevraagd', Boolean(dialoog) && /Conceptbetaling van .* klaarzetten in bunq/.test(dialoog), String(dialoog));
controleer('zonder bevestiging van het nieuwe IBAN: niets klaargezet', bunq.aangemaakt.length === 1 && await browser.evalueer(`/Bevestig het nieuwe IBAN/.test(document.body.textContent)`));

// Nu met de vinkjes, maar eerst "Annuleren" in de dialoog.
await browser.evalueer(`for (const i of document.querySelectorAll('input[name^="nieuw_"]')) i.checked = true`);
dialoog = null;
antwoord = false;
browser.s('Runtime.evaluate', { expression: `document.querySelector('form.bevestig button[type="submit"]').click()` }).catch(() => {});
await wacht(700);
controleer('annuleren in de dialoog: niets klaargezet', Boolean(dialoog) && bunq.aangemaakt.length === 1);

// En dan echt.
await browser.open(basis + '/betalen', 400);
await browser.evalueer(kies);
await browser.evalueer(`document.querySelector('form.kieslijst button[type="submit"]').click()`);
await wacht(600);
await browser.evalueer(`for (const i of document.querySelectorAll('input[name^="nieuw_"]')) i.checked = true`);
dialoog = null;
antwoord = true;
browser.s('Runtime.evaluate', { expression: `document.querySelector('form.bevestig button[type="submit"]').click()` }).catch(() => {});
await wacht(1000);
controleer('na bevestigen: één conceptbetaling met twee regels', bunq.aangemaakt.length === 2 && bunq.aangemaakt[1].regels.length === 2, String(bunq.aangemaakt.length));
controleer('melding "Klaargezet in bunq" op de lijst', await browser.evalueer(`/Klaargezet in bunq/.test(document.body.textContent)`));
await afdruk('na-klaarzetten-390');

const echteFouten = browser.fouten.filter((fout) => !/favicon/i.test(fout) && !/HTTP 409/.test(fout));
controleer('geen JS-fouten of mislukte verzoeken (de bewuste 409 daargelaten)', !echteFouten.length, echteFouten.slice(0, 3).join(' | '));

browser.stop();
await new Promise((klaar) => server.close(klaar));
rmSync(map, { recursive: true, force: true });

console.log(`\n${geslaagd} geslaagd, ${gezakt.length} gezakt`);
if (gezakt.length) {
  for (const regel of gezakt) console.log('  - ' + regel);
  process.exit(1);
}
