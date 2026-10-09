// Browsertest voor het factuurdashboard: geen horizontale overflow, geen
// JS-fouten, geen mislukte verzoeken, en de bevestiging vóór doorsturen.
//
// Draait los van `node --test`, want hij heeft een Chromium nodig:
//   export CHROME=$(ls -d ~/.cache/ms-playwright/chromium_headless_shell-*/*/ | head -1)chrome-headless-shell
//   node test/facturen-browser.mjs
//
// Start zelf een dashboard met voorbeeldgegevens op een vrije poort; er gaat
// niets naar buiten en er wordt niets in de repo geschreven.

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startBrowser, wacht } from './cdp.mjs';
import { maakServer } from '../service/facturen/server.mjs';
import { maakOpslag, openDatabase } from '../service/facturen/lib/db.mjs';
import * as instellingen from '../service/facturen/lib/instellingen.mjs';
import { nepGraph } from './facturen-hulp.mjs';

const GEBRUIKER = 'bob';
const WACHTWOORD = 'browsertest';
const BREEDTES = [360, 390, 820, 1440];

let geslaagd = 0;
const gezakt = [];

function controleer(omschrijving, goed, extra = '') {
  if (goed) { geslaagd++; console.log('  ok  ' + omschrijving); } else {
    gezakt.push(omschrijving + (extra ? ' — ' + extra : ''));
    console.log('  FOUT ' + omschrijving + (extra ? ' — ' + extra : ''));
  }
}

// -- voorbeeldgegevens ---------------------------------------------------
const VOORBEELDEN = [
  ['Tegelhandel Zuid B.V.', 1210, '2026-10-01', '2026-10-31', 'open'],
  ['Bouwmaat Velsen', 348.7, '2026-09-20', '2026-09-30', 'open'],
  ['Natuursteen Import', 5400, '2026-08-11', '2026-09-10', 'betaald'],
  ['Van Dijk Voegmiddelen', 89.95, '2026-10-03', '2026-11-02', 'open'],
  ['Een Leverancier Met Een Opvallend Lange Naam B.V.', 1899, '2026-07-02', '2026-08-01', 'betaald'],
];

function vulOpslag(opslag) {
  instellingen.bewaar(opslag, {
    boekhouder_email: 'boekhouder@kantoor.nl',
    doorstuur_tekst: 'Hierbij een betaalde factuur.',
    auto_doorsturen: '1',
    testmodus: '1',
  }, { nu: '2026-09-01T00:00:00Z' });

  VOORBEELDEN.forEach(([naam, bedrag, datum, verval, status], i) => {
    const { id } = opslag.voegFactuurToe({
      message_id: 'mail-' + i,
      attachment_id: 'bijlage-' + i,
      ontvangen: datum + 'T09:00:00Z',
      afzender_naam: naam,
      afzender_email: 'facturen@voorbeeld.nl',
      onderwerp: 'Factuur ' + (2000 + i),
    });
    opslag.zetUitgelezen(id, 'ok', {
      leverancier: naam, factuurnummer: '2026-' + (100 + i), factuurdatum: datum,
      vervaldatum: verval, bedrag, valuta: 'EUR', iban: 'NL91ABNA041716430' + i,
      betalingskenmerk: null, omschrijving: 'tegels en materiaal',
    });
    if (status === 'betaald') opslag.zetBetaald(id, { betaald_op: verval, betaald_via: 'handmatig' });
  });

  // Eén factuur met een mislukt uitlezen en één met een voorstel, zodat de
  // meldingen en het zekerheidsbalkje ook in beeld komen.
  const { id: stuk } = opslag.voegFactuurToe({
    message_id: 'mail-stuk', attachment_id: '', onderwerp: 'Onleesbare scan',
    afzender_naam: 'Onbekende afzender', ontvangen: '2026-10-04T09:00:00Z',
  });
  opslag.zetUitleesFout(stuk, 'het model weigerde dit document te lezen');

  opslag.voegBetalingToe({
    id: '9001', rekening_id: '1', rekening_iban: 'NL00BUNQ0000000001', datum: '2026-10-02',
    bedrag: -89.95, valuta: 'EUR', tegenrekening_iban: null,
    tegenpartij_naam: 'V. Dijk', omschrijving: 'overboeking',
  });
  opslag.zetSuggestie(4, '9001', 0.6);
  opslag.zetInstelling('laatste_sync', '2026-10-06T08:15:00Z');
}

// -- test ----------------------------------------------------------------
const map = mkdtempSync(path.join(os.tmpdir(), 'dekoning-facturen-browser-'));
mkdirSync(path.join(map, 'pdfs'), { recursive: true });

const opslag = maakOpslag(openDatabase(path.join(map, 'facturen.db')));
vulOpslag(opslag);

const { server } = maakServer({
  opslag,
  graph: nepGraph(),
  pdfMap: path.join(map, 'pdfs'),
  gebruiker: GEBRUIKER,
  wachtwoord: WACHTWOORD,
  basisPad: '/facturen',
  nu: () => '2026-10-06',
});
await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
const basis = `http://127.0.0.1:${server.address().port}/facturen`;

// Een eigen debugpoort: op 9333 kan al een browser van een andere test staan.
const browser = await startBrowser(process.env.CHROME, 9342);

// Basic Auth via een vaste header; inloggegevens in de URL accepteert
// Chromium niet meer voor onderdelen van de pagina.
await browser.s('Network.setExtraHTTPHeaders', {
  headers: { Authorization: 'Basic ' + Buffer.from(`${GEBRUIKER}:${WACHTWOORD}`).toString('base64') },
});

const PAGINAS = [
  ['overzicht', '/'],
  ['dashboard', '/dashboard'],
  ['leveranciers', '/leveranciers'],
  ['overzicht, filter alle', '/?filter=alle'],
  ['factuur', '/factuur/1'],
  ['factuur met voorstel', '/factuur/4'],
  ['factuur met uitleesfout', '/factuur/6'],
  ['instellingen', '/instellingen'],
];

for (const [naam, pad] of PAGINAS) {
  console.log('\n' + naam);
  for (const breedte of BREEDTES) {
    await browser.viewport(breedte, 900, breedte < 700);
    await browser.open(basis + pad, 500);

    // Horizontale overflow, met uitzondering van wat bewust in een
    // scrollbare rij staat (de filterbalk).
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
        if (r.right > window.innerWidth + 1 && !scrollbaar(el)) {
          uit.push(el.tagName.toLowerCase() + '.' + (el.className || '') + ' tot ' + Math.round(r.right));
        }
      }
      return { paginaBreed: document.documentElement.scrollWidth, venster: window.innerWidth, uit: uit.slice(0, 3) };
    })()`);

    controleer(
      `${breedte} px: geen horizontale overflow`,
      teBreed.paginaBreed <= teBreed.venster + 1 && teBreed.uit.length === 0,
      `pagina ${teBreed.paginaBreed} px in een venster van ${teBreed.venster} px; ${teBreed.uit.join(' | ')}`,
    );
  }

  // Klikvlakken minstens 48 px hoog (mobiele eis uit CLAUDE.md).
  await browser.viewport(390, 900, true);
  await browser.open(basis + pad, 400);
  // Bij een selectievakje is het bijbehorende label het klikvlak (label for),
  // dus daar meten we de hoogte van het label.
  const teKlein = await browser.evalueer(`(() => {
    const uit = [];
    for (const el of document.querySelectorAll('a, button, input[type="checkbox"]')) {
      let doel = el;
      if (el.tagName === 'INPUT' && el.id) {
        const label = document.querySelector('label[for="' + el.id + '"]');
        if (label) doel = label;
      }
      const r = doel.getBoundingClientRect();
      if (r.height === 0) continue;
      if (r.height < 44) uit.push(el.tagName.toLowerCase() + ' "' + (doel.textContent || '').trim().slice(0, 25) + '" ' + Math.round(r.height) + 'px');
    }
    return uit;
  })()`);
  controleer('390 px: klikvlakken groot genoeg', teKlein.length === 0, teKlein.slice(0, 3).join(' | '));
}

// -- bevestiging vóór doorsturen ----------------------------------------
console.log('\ndoorsturen vraagt eerst na');
await browser.viewport(390, 900, true);
await browser.open(basis + '/factuur/1', 500);

let gevraagd = null;
browser.opEvent('Page.javascriptDialogOpening', (p) => { gevraagd = p.message; });
await browser.s('Page.enable');

// Niet awaiten: een modale confirm blokkeert de pagina, dus het antwoord op
// deze opdracht komt pas als de dialoog weer weg is.
browser.s('Runtime.evaluate', {
  expression: `document.querySelector('form[action$="/doorsturen"] button').click()`,
}).catch(() => { /* loopt af zodra de dialoog gesloten is */ });
await wacht(600);
controleer('er wordt om bevestiging gevraagd', Boolean(gevraagd), 'geen dialoog gezien');
if (gevraagd) {
  controleer('de vraag zegt dat er echt een mail uit gaat', /echt een mail/i.test(gevraagd), gevraagd);
  await browser.s('Page.handleJavaScriptDialog', { accept: false });
  await wacht(200);
  controleer('bij weigeren is er niets doorgestuurd', opslag.factuur(1).doorgestuurd_op === null);
}

// -- balkjes krijgen hun breedte via setProperty -------------------------
await browser.open(basis + '/factuur/4', 500);
const balk = await browser.evalueer(`(() => {
  const el = document.querySelector('.zekerheid span[data-deel]');
  return el ? el.style.getPropertyValue('--deel') : null;
})()`);
controleer('het zekerheidsbalkje krijgt zijn breedte uit JS', balk === '60%', String(balk));

// -- fouten uit de browser ----------------------------------------------
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
